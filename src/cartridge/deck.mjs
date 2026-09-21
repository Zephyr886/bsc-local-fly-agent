import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fullBrainWorkerEnv } from '../brain/full-brain-client.mjs';
import { ACTIVE_MAINNET_V3_REGISTRY, CARTRIDGE_V3_LIMITS } from '../chain/registry-config.mjs';
import { DATA_ROOT, RUNTIME_ROOT } from '../paths.mjs';
import { recover } from '../../scripts/fly_cartridge_v3_direct_chain_read.mjs';

const RPC_URLS = ['https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed-public.bnbchain.org'];
const CARD_ID = /^0x[0-9a-fA-F]{64}$/;
const TOKEN = /^0x[0-9a-fA-F]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const V4_MAX_MANIFEST_BYTES = 32_768;
const V4_MAX_STATE_BYTES = 262_144;

function checkBytes(manifest, state) {
  if (!Buffer.isBuffer(manifest) || !Buffer.isBuffer(state) ||
      manifest.length < 1 || manifest.length > CARTRIDGE_V3_LIMITS.maxManifestBytes ||
      state.length < 1 ||
      manifest.length + state.length > CARTRIDGE_V3_LIMITS.maxPublicationBytes) {
    throw new Error('卡带文件大小无效；清单最多 16,384 字节，总计最多 120,000 字节');
  }
}
function checkToken(address) {
  if (!TOKEN.test(address || '') || BigInt(address) === 0n) {
    throw new Error('请选择本地运行环境的非零 BSC 代币地址');
  }
  return address.toLowerCase();
}

function manifestVersion(manifest) {
  let parsed;
  try { parsed = JSON.parse(manifest.toString('utf8')); }
  catch {
    if (manifest.length > CARTRIDGE_V3_LIMITS.maxManifestBytes) {
      throw new Error('卡带文件大小无效；清单最多 16,384 字节，总计最多 120,000 字节');
    }
    throw new Error('cartridge.json 不是有效 JSON');
  }
  if (parsed?.format !== 'fly-cartridge' || ![3, 4].includes(parsed?.formatVersion)) {
    throw new Error('仅支持 Fly Cartridge v3 或 v4');
  }
  return parsed.formatVersion;
}

function checkV4Bytes(manifest, state) {
  if (!Buffer.isBuffer(manifest) || !Buffer.isBuffer(state) || manifest.length < 1 ||
      manifest.length > V4_MAX_MANIFEST_BYTES || state.length < 1 ||
      state.length > V4_MAX_STATE_BYTES) {
    throw new Error('v4 卡带文件大小无效；清单最多 32KB，状态最多 256KB');
  }
}
async function atomicJson(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { flag: 'wx' });
  await rename(tmp, path);
}

export function runV3(python, args, { timeoutMs = 180_000 } = {}) {
  return runCartridgeTool(python, 'scripts/fly_cartridge_v3.py', args, { timeoutMs });
}

export function runV4(python, args, { timeoutMs = 180_000 } = {}) {
  return runCartridgeTool(python, 'scripts/fly_cartridge_v4.py', args, { timeoutMs });
}

function runCartridgeTool(python, script, args, { timeoutMs }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(python, [script, ...args], {
      cwd: RUNTIME_ROOT, windowsHide: true,
      env: fullBrainWorkerEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('卡带神经验证超时')); }, timeoutMs);
    child.stdout.on('data', (data) => { stdout += data.toString(); if (stdout.length > 32_768) child.kill(); });
    child.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-8_192); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim().split(/\r?\n/).at(-1) || '卡带神经验证失败'));
      try { resolveResult(JSON.parse(stdout)); }
      catch { reject(new Error('卡带工具未返回有效验证结果')); }
    });
  });
}

export async function recoverMainnet(cardId) {
  if (!CARD_ID.test(cardId || '')) throw new Error('Card ID 格式无效');
  let last;
  for (const rpc of RPC_URLS) {
    try { return await recover({ rpc, address: ACTIVE_MAINNET_V3_REGISTRY.address, cardId,
      chainId: ACTIVE_MAINNET_V3_REGISTRY.chainId,
      image: ACTIVE_MAINNET_V3_REGISTRY.reader.image }); }
    catch (error) { last = error; }
  }
  throw last instanceof Error ? last : new Error('主网 RPC 暂不可用');
}

export class CartridgeDeck {
  constructor({ root = join(DATA_ROOT, 'cartridge-console'),
    brain, runtime, repository = null, getActiveContext = () => null,
    activateFly = null, run = runV3, runV4: runV4Tool = runV4,
    chainRead = recoverMainnet } = {}) {
    this.root = resolve(root);
    this.brain = brain;
    this.runtime = runtime;
    this.repository = repository;
    this.getActiveContext = getActiveContext;
    this.activateFly = activateFly;
    this.run = run;
    this.runV4 = runV4Tool;
    this.chainRead = chainRead;
    this.busy = false;
    this.activeFile = join(this.root, 'active.json');
    this.lastExportFile = join(this.root, 'last-export.json');
    this.active = this.readMarker(this.activeFile);
    this.lastExport = this.readMarker(this.lastExportFile);
    if (this.active?.id && (!UUID.test(this.active.id) || !existsSync(this.runCheckpoint(this.active.id)))) {
      this.active = null;
    }
  }

  readMarker(path) {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch { return null; }
  }
  runCheckpoint(id) { return join(this.root, 'runs', id, 'service.npz'); }

  currentFly() {
    const context = this.getActiveContext?.();
    return context?.flyId && UUID.test(context.flyId) ? context : null;
  }

  perFlyMarker(context, name) {
    if (!context || !this.repository) return null;
    return this.readMarker(this.repository.cartridgeMarkerPath(context.flyId, name));
  }

  status() {
    const context = this.currentFly();
    const active = this.perFlyMarker(context, 'active.json');
    const lastExport = this.perFlyMarker(context, 'last-export.json');
    return { active: active ?? (!this.repository ? this.active : null),
      lastExport: lastExport ?? (!this.repository ? this.lastExport : null),
      flyId: context?.flyId ?? null, localFormatVersion: 4,
      worker: this.brain.snapshot(), busy: this.busy,
      simulation: this.runtime.state.status,
      contract: ACTIVE_MAINNET_V3_REGISTRY.address,
      registry: { id: ACTIVE_MAINNET_V3_REGISTRY.id,
        type: ACTIVE_MAINNET_V3_REGISTRY.contractType,
        chainId: ACTIVE_MAINNET_V3_REGISTRY.chainId,
        address: ACTIVE_MAINNET_V3_REGISTRY.address } };
  }

  async completeLegacyMigration(flyId, checkpointId) {
    if (!this.active || !existsSync(this.activeFile)) return false;
    await mkdir(this.root, { recursive: true });
    await atomicJson(join(this.root, 'legacy-active-migrated.json'), {
      ...this.active, migratedTo: { flyId, checkpointId }, migratedAt: new Date().toISOString(),
    });
    await rm(this.activeFile, { force: true });
    this.active = null;
    return true;
  }
  async guarded(fn) {
    if (this.busy) throw new Error('另一项卡带操作正在进行');
    if (this.runtime.state.status === 'running') throw new Error('请先暂停运行时，再导入、切换或导出卡带');
    this.busy = true;
    try { return await fn(); }
    finally { this.busy = false; }
  }

  async importBytes({ manifest, state, tokenAddress, source = 'file' }) {
    const version = manifestVersion(manifest);
    if (version === 3) checkBytes(manifest, state);
    else checkV4Bytes(manifest, state);
    const token = version === 3 ? checkToken(tokenAddress)
      : (tokenAddress ? checkToken(tokenAddress) : null);
    if (!this.repository || typeof this.activateFly !== 'function') {
      if (version !== 3) throw new Error('当前运行时尚未启用逐果蝇 v4 卡带');
      return this.importV3Legacy({ manifest, state, token, source });
    }
    return this.guarded(async () => {
      await this.brain.park();
      const importId = randomUUID();
      const flyId = version === 3 ? randomUUID() : null;
      const staging = join(this.root, 'staging', importId);
      const input = join(staging, 'input');
      const translated = join(staging, 'v4');
      const installed = join(staging, 'checkpoint');
      await mkdir(input, { recursive: true });
      try {
        await Promise.all([
          writeFile(join(input, 'cartridge.json'), manifest, { flag: 'wx' }),
          writeFile(join(input, 'state.bin'), state, { flag: 'wx' }),
        ]);
        let cartridgeDirectory = input;
        let wrapped = null;
        if (version === 3) {
          wrapped = await this.runV4(this.brain.python,
            ['wrap-v3', input, '--fly-id', flyId, '--out', translated]);
          cartridgeDirectory = translated;
        }
        const result = await this.runV4(this.brain.python,
          ['install', cartridgeDirectory, '--out', installed]);
        if (!existsSync(join(installed, 'service.npz')) || !UUID.test(result.fly?.flyId || '')) {
          throw new Error('卡带安装未生成有效的逐果蝇 checkpoint');
        }
        const fixedToken = result.profile?.universe?.tokenBinding === 'fixed'
          ? result.profile.universe.tokenAddress.toLowerCase() : null;
        if (fixedToken && token && fixedToken !== token) {
          throw new Error('v4 固定代币与本机选择的代币地址不一致');
        }
        const active = { cardId: `0x${result.cardId}`, tokenAddress: fixedToken ?? token,
          source, sourceFormatVersion: version, formatVersion: 4,
          importedAt: new Date().toISOString(), provenance: result.provenance };
        const fly = await this.repository.createFromCartridge({
          id: result.fly.flyId,
          revision: result.fly.profileRevision,
          name: version === 3 ? 'Imported v3' : 'Imported Cartridge',
          description: version === 3 ? '从 Fly Cartridge v3 包装导入' : '从 Fly Cartridge v4 导入',
          tags: version === 3 ? ['v3-import'] : ['cartridge-import'],
          spec: result.profile,
          checkpointDirectory: installed,
          importId,
          cartridgeDirectory,
          activeCartridge: active,
        });
        await this.activateFly(fly.id);
        return { ...active, id: importId, flyId: fly.id,
          profileHash: result.profileHash, traitKey: result.traitKey,
          stateSha256: result.stateSha256, stateBytes: result.stateBytes,
          wrappedFrom: wrapped?.sourceCardId ?? null,
          fixedBootProbe: result.fixedBootProbe };
      } finally {
        // staging is an exact UUID directly below the fixed deck root.
        await rm(staging, { recursive: true, force: true });
      }
    });
  }

  async importV3Legacy({ manifest, state, token, source }) {
    return this.guarded(async () => {
      await this.brain.park();
      const previous = this.active;
      const previousCheckpoint = this.brain.checkpoint;
      const id = randomUUID();
      const input = join(this.root, 'inputs', id);
      const output = join(this.root, 'runs', id);
      let markerWritten = false;
      await mkdir(input, { recursive: true });
      try {
        await Promise.all([
          writeFile(join(input, 'cartridge.json'), manifest, { flag: 'wx' }),
          writeFile(join(input, 'state.bin'), state, { flag: 'wx' }),
        ]);
        const result = await this.run(this.brain.python,
          ['install', input, '--out', output, '--token-address', token]);
        if (!existsSync(this.runCheckpoint(id))) throw new Error('卡带安装未生成设备检查点');
        const active = { id, cardId: `0x${result.cardId}`, tokenAddress: token,
          source, importedAt: new Date().toISOString() };
        await mkdir(this.root, { recursive: true });
        await atomicJson(this.activeFile, active);
        markerWritten = true;
        this.brain.activateCheckpoint(this.runCheckpoint(id));
        this.active = active;
        return { ...active, stateBytes: result.stateBytes, fixedBootProbe: result.fixedBootProbe };
      } catch (error) {
        if (markerWritten) {
          if (previous) await atomicJson(this.activeFile, previous);
          else await rm(this.activeFile, { force: true });
        }
        if (this.brain.checkpoint !== previousCheckpoint) this.brain.activateCheckpoint(previousCheckpoint);
        await Promise.all([rm(input, { recursive: true, force: true }),
          rm(output, { recursive: true, force: true })]);
        throw error;
      }
    });
  }

  async importFromChain({ cardId, tokenAddress }) {
    if (!CARD_ID.test(cardId || '')) throw new Error('Card ID 格式无效');
    checkToken(tokenAddress);
    if (this.runtime.state.status === 'running') throw new Error('请先暂停运行时');
    const recovered = await this.chainRead(cardId);
    return this.importBytes({ manifest: recovered.manifest, state: recovered.state,
      tokenAddress, source: 'bsc-mainnet' });
  }

  async exportActive() {
    const context = this.currentFly();
    if (!context || !this.repository) return this.exportActiveLegacy();
    return this.guarded(async () => {
      await this.brain.park();
      if (this.brain.checkpoint !== context.checkpointPath || !existsSync(context.checkpointPath)) {
        throw new Error('当前设备没有全脑检查点；请先启动并运行一次');
      }
      const id = randomUUID();
      const output = dirname(this.repository.cartridgeFilePath(
        context.flyId, 'exports', id, 'cartridge.json'));
      await mkdir(dirname(output), { recursive: true });
      try {
        const result = await this.runV4(this.brain.python,
          ['export', '--checkpoint', context.checkpointPath,
            '--profile', this.repository.profileFilePath(context.flyId, context.revision),
            '--out', output]);
        const marker = { id, cardId: `0x${result.cardId}`,
          flyId: context.flyId, formatVersion: 4, profileHash: result.profileHash,
          traitKey: result.traitKey, stateSha256: result.stateSha256,
          stateBytes: result.stateBytes, manifestBytes: result.manifestBytes,
          publishability: result.publishability, exportedAt: new Date().toISOString() };
        await atomicJson(this.repository.cartridgeMarkerPath(context.flyId, 'last-export.json'), marker);
        return marker;
      } catch (error) {
        await rm(output, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async exportActiveLegacy() {
    return this.guarded(async () => {
      await this.brain.park();
      if (!existsSync(this.brain.checkpoint)) {
        throw new Error('当前设备没有全脑检查点；请先启动并运行一次');
      }
      const id = randomUUID();
      const output = join(this.root, 'exports', id);
      await mkdir(dirname(output), { recursive: true });
      try {
        const result = await this.run(this.brain.python,
          ['export', '--checkpoint', this.brain.checkpoint, '--out', output]);
        const marker = { id, cardId: `0x${result.cardId}`,
          stateBytes: result.stateBytes, manifestBytes: result.manifestBytes,
          exportedAt: new Date().toISOString() };
        await atomicJson(this.lastExportFile, marker);
        this.lastExport = marker;
        return marker;
      } catch (error) {
        await rm(output, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async exportFile(id, name) {
    if (!UUID.test(id || '') ||
        !['cartridge.json', 'state.bin'].includes(name)) throw new Error('导出文件路径无效');
    const context = this.currentFly();
    if (context && this.repository) {
      return readFile(this.repository.cartridgeFilePath(context.flyId, 'exports', id, name));
    }
    return readFile(join(this.root, 'exports', id, name));
  }
}
