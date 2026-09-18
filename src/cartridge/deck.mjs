import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fullBrainWorkerEnv } from '../brain/full-brain-client.mjs';
import { recover } from '../../scripts/fly_cartridge_v3_direct_chain_read.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MAINNET_CARTRIDGE_CONTRACT = '0x8a318b90ae7ce6c3c55dd5f596e16c1623c2c46a';
const RPC_URLS = ['https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed-public.bnbchain.org'];
const MAX_MANIFEST = 16_384;
const MAX_TOTAL = 120_000;
const CARD_ID = /^0x[0-9a-fA-F]{64}$/;
const TOKEN = /^0x[0-9a-fA-F]{40}$/;

function checkBytes(manifest, state) {
  if (!Buffer.isBuffer(manifest) || !Buffer.isBuffer(state) ||
      manifest.length < 1 || manifest.length > MAX_MANIFEST ||
      state.length < 1 || manifest.length + state.length > MAX_TOTAL) {
    throw new Error('卡带文件大小无效；清单最多 16,384 字节，总计最多 120,000 字节');
  }
}
function checkToken(address) {
  if (!TOKEN.test(address || '') || BigInt(address) === 0n) {
    throw new Error('请选择本地运行环境的非零 BSC 代币地址');
  }
  return address.toLowerCase();
}
async function atomicJson(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { flag: 'wx' });
  await rename(tmp, path);
}

export function runV3(python, args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(python, ['scripts/fly_cartridge_v3.py', ...args], {
      cwd: PROJECT_ROOT, windowsHide: true,
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
    try { return await recover({ rpc, address: MAINNET_CARTRIDGE_CONTRACT, cardId, chainId: 56 }); }
    catch (error) { last = error; }
  }
  throw last instanceof Error ? last : new Error('主网 RPC 暂不可用');
}

export class CartridgeDeck {
  constructor({ root = join(PROJECT_ROOT, 'data', 'cartridge-console'),
    brain, runtime, run = runV3, chainRead = recoverMainnet } = {}) {
    this.root = resolve(root);
    this.brain = brain;
    this.runtime = runtime;
    this.run = run;
    this.chainRead = chainRead;
    this.busy = false;
    this.activeFile = join(this.root, 'active.json');
    this.lastExportFile = join(this.root, 'last-export.json');
    this.active = this.readMarker(this.activeFile);
    this.lastExport = this.readMarker(this.lastExportFile);
    if (this.active?.id && /^[0-9a-f-]{36}$/.test(this.active.id)) {
      const checkpoint = this.runCheckpoint(this.active.id);
      if (existsSync(checkpoint)) this.brain.activateCheckpoint(checkpoint);
      else this.active = null;
    }
  }

  readMarker(path) {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch { return null; }
  }
  runCheckpoint(id) { return join(this.root, 'runs', id, 'service.npz'); }
  status() {
    return { active: this.active, lastExport: this.lastExport,
      worker: this.brain.snapshot(), busy: this.busy,
      simulation: this.runtime.state.status,
      contract: MAINNET_CARTRIDGE_CONTRACT };
  }
  async guarded(fn) {
    if (this.busy) throw new Error('另一项卡带操作正在进行');
    if (this.runtime.state.status === 'running') throw new Error('请先暂停运行时，再导入、切换或导出卡带');
    this.busy = true;
    try { return await fn(); }
    finally { this.busy = false; }
  }

  async importBytes({ manifest, state, tokenAddress, source = 'file' }) {
    checkBytes(manifest, state);
    const token = checkToken(tokenAddress);
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
        return { ...active, stateBytes: result.stateBytes,
          fixedBootProbe: result.fixedBootProbe };
      } catch (error) {
        if (markerWritten) {
          if (previous) await atomicJson(this.activeFile, previous);
          else await rm(this.activeFile, { force: true });
        }
        if (this.brain.checkpoint !== previousCheckpoint) {
          this.brain.activateCheckpoint(previousCheckpoint);
        }
        // Both paths are made from a UUID directly below the fixed deck root.
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
    if (!/^[0-9a-f-]{36}$/.test(id || '') ||
        !['cartridge.json', 'state.bin'].includes(name)) throw new Error('导出文件路径无效');
    return readFile(join(this.root, 'exports', id, name));
  }
}
