import crypto, { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPublicClient, encodeDeployData, formatEther, getContractAddress, http } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import { APP_ROOT } from '../paths.mjs';
import { BSC_RPC_URL, BSC_TESTNET_RPC_URL } from '../config.mjs';
import { expectedRuntimeCode, parseManifestCommitments,
  recoverV4 } from '../../scripts/fly_cartridge_v4_chain_read.mjs';

const artifactPath = join(APP_ROOT, 'artifacts', 'fly-cartridge-v4-registry-candidate.json');
const artifactBytes = readFileSync(artifactPath);
const artifact = JSON.parse(artifactBytes);
const ARTIFACT_SHA256 = crypto.createHash('sha256').update(artifactBytes).digest('hex');
const SOURCE_SHA256 = 'be87b2b91967480ac4a8b634b1e7146ddecd2fa4b2c8096222b4db00810ebc47';
const MAINNET_PHRASE = '确认主网部署并发布卡带';
const TESTNET_PHRASE = '确认测试网部署并发布卡带';
const DEPLOY_GAS_BUFFER_PERCENT = 20n;
const PUBLICATION_GAS_BUDGET = 6_000_000n;
const AUTHORIZATION_TTL_MS = 5 * 60_000;

export const REGISTRY_V4_NETWORKS = Object.freeze({
  mainnet: Object.freeze({ name: 'BSC Mainnet', chain: bsc, chainId: 56,
    rpc: BSC_RPC_URL, genesis: '0x0d21840abff46b96c84b2ac9e10e4f5cdaeb5693cb665db62a2f3b02d2d57b5b',
    confirmations: 5, explorer: 'https://bscscan.com' }),
  testnet: Object.freeze({ name: 'BSC Testnet', chain: bscTestnet, chainId: 97,
    rpc: BSC_TESTNET_RPC_URL, genesis: '0x6d3c66c5357ec91d5c43af47e234a939b22557cbb552dc45bebbceeed90fbe34',
    confirmations: 2, explorer: 'https://testnet.bscscan.com' }),
});

const digestHex = (hex) => crypto.createHash('sha256')
  .update(Buffer.from(hex.slice(2), 'hex')).digest('hex');
const jsonClone = (value) => JSON.parse(JSON.stringify(value));

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

function networkFor(name) {
  const selected = REGISTRY_V4_NETWORKS[name];
  if (!selected) throw new Error('Registry V4 网络无效');
  return selected;
}

function publicClient(network) {
  return createPublicClient({ chain: network.chain,
    transport: http(network.rpc, { timeout: 15_000, retryCount: 1 }) });
}

export class RegistryV4Console {
  constructor({ wallet, deck, statePath, now = () => Date.now() }) {
    this.wallet = wallet;
    this.deck = deck;
    this.statePath = statePath;
    this.now = now;
    this.authorizations = new Map();
  }

  readState() {
    try {
      const value = JSON.parse(readFileSync(this.statePath, 'utf8'));
      return value?.version === 1 && value.deployments && typeof value.deployments === 'object'
        ? value : { version: 1, deployments: {} };
    } catch {
      return { version: 1, deployments: {} };
    }
  }

  async writeDeployment(networkName, deployment) {
    const state = this.readState();
    state.deployments[networkName] = deployment;
    await atomicJson(this.statePath, state);
  }

  cleanupAuthorizations() {
    const now = this.now();
    for (const [id, value] of this.authorizations) {
      if (value.expiresAt <= now || value.state === 'used') this.authorizations.delete(id);
    }
    while (this.authorizations.size >= 20) {
      this.authorizations.delete(this.authorizations.keys().next().value);
    }
  }

  async assertNetwork(client, network) {
    const [chainId, genesis] = await Promise.all([
      client.getChainId(), client.getBlock({ blockNumber: 0n }),
    ]);
    if (chainId !== network.chainId || genesis.hash?.toLowerCase() !== network.genesis) {
      throw new Error(`RPC 不是 ${network.name}`);
    }
  }

  async assertDeployment(client, network, address) {
    const [code, deploymentChainId] = await Promise.all([
      client.getBytecode({ address }),
      client.readContract({ address, abi: artifact.abi,
        functionName: 'deploymentChainId' }),
    ]);
    if (!code || code.toLowerCase() !== expectedRuntimeCode(network.chainId).toLowerCase() ||
        deploymentChainId !== BigInt(network.chainId)) {
      throw new Error('登记地址不是本构建的 Registry V4 合约');
    }
    return code;
  }

  async status() {
    const wallet = await this.wallet.status();
    const deployments = this.readState().deployments;
    const networks = {};
    for (const [name, network] of Object.entries(REGISTRY_V4_NETWORKS)) {
      const client = publicClient(network);
      try {
        await this.assertNetwork(client, network);
        const balance = wallet.exists
          ? await client.getBalance({ address: wallet.address }) : 0n;
        const deployment = deployments[name] || null;
        let verified = false;
        if (deployment?.address) {
          try { await this.assertDeployment(client, network, deployment.address); verified = true; }
          catch { verified = false; }
        }
        networks[name] = { name: network.name, chainId: network.chainId,
          explorer: network.explorer, rpcReady: true,
          balanceWei: balance.toString(), balanceBnb: formatEther(balance),
          deployment, verified };
      } catch (error) {
        networks[name] = { name: network.name, chainId: network.chainId,
          explorer: network.explorer, rpcReady: false, error: error.message,
          deployment: deployments[name] || null, verified: false };
      }
    }
    let candidate = null;
    try {
      const value = await this.deck.registryV4Candidate();
      const commitments = parseManifestCommitments(value.manifest, value.state);
      candidate = { exportId: value.marker.id, cardId: commitments.cardId,
        profileHash: commitments.profileHash, stateSha256: commitments.stateSha256,
        manifestBytes: value.manifest.length, stateBytes: value.state.length };
    } catch (error) {
      candidate = { error: error.message };
    }
    return { wallet, artifact: { contractName: artifact.contractName,
      artifactSha256: ARTIFACT_SHA256, sourceSha256: SOURCE_SHA256,
      runtimeBytecodeSha256: {
        mainnet: digestHex(expectedRuntimeCode(56)),
        testnet: digestHex(expectedRuntimeCode(97)),
      }, constructor: ['expectedChainId'], immutable: true, upgradeable: false },
      networks, candidate };
  }

  async prepare({ network: networkName, mode }) {
    if (!['deploy', 'deploy-and-publish', 'publish'].includes(mode)) {
      throw new Error('Registry V4 操作模式无效');
    }
    const network = networkFor(networkName);
    const wallet = await this.wallet.status();
    if (!wallet.exists) throw new Error('请先创建本地加密钱包');
    const client = publicClient(network);
    await this.assertNetwork(client, network);
    const saved = this.readState().deployments[networkName] || null;
    if (mode === 'publish' && !saved?.address) throw new Error('该网络尚未登记 Registry V4');
    if (mode !== 'publish' && saved?.address) throw new Error('该网络已登记 Registry V4，拒绝重复部署');
    if (saved?.address) await this.assertDeployment(client, network, saved.address);

    let candidate = null;
    if (mode !== 'deploy') {
      const value = await this.deck.registryV4Candidate();
      const commitments = parseManifestCommitments(value.manifest, value.state);
      candidate = { exportId: value.marker.id, ...commitments,
        manifestBytes: value.manifest.length, stateBytes: value.state.length };
    }
    const gasPrice = await client.getGasPrice();
    const balance = await client.getBalance({ address: wallet.address });
    let deployGas = 0n;
    let expectedAddress = saved?.address || null;
    if (mode !== 'publish') {
      const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode,
        args: [BigInt(network.chainId)] });
      deployGas = await client.estimateGas({ account: wallet.address, data });
      const nonce = await client.getTransactionCount({ address: wallet.address,
        blockTag: 'pending' });
      expectedAddress = getContractAddress({ from: wallet.address, nonce });
    }
    let publishGas = 0n;
    if (mode === 'publish') {
      const value = await this.deck.registryV4Candidate();
      publishGas = await client.estimateContractGas({ address: expectedAddress,
        abi: artifact.abi, functionName: 'publish', account: wallet.address,
        args: this.publishArgs(value.manifest, value.state, candidate) });
    } else if (mode === 'deploy-and-publish') {
      publishGas = PUBLICATION_GAS_BUDGET;
    }
    const bufferedDeployGas = deployGas + deployGas * DEPLOY_GAS_BUFFER_PERCENT / 100n;
    const maximumGas = bufferedDeployGas + publishGas + publishGas / 5n;
    const maximumCost = maximumGas * gasPrice;
    if (balance < maximumCost) {
      throw new Error(`余额不足：最大预算 ${formatEther(maximumCost)} BNB，当前 ${formatEther(balance)} BNB`);
    }
    this.cleanupAuthorizations();
    const authorizationId = randomUUID();
    const expiresAt = this.now() + AUTHORIZATION_TTL_MS;
    this.authorizations.set(authorizationId, { state: 'ready', expiresAt,
      network: networkName, mode, account: wallet.address,
      expectedAddress, exportId: candidate?.exportId ?? null,
      cardId: candidate?.cardId ?? null, artifactSha256: ARTIFACT_SHA256,
      deployGas, maximumGas });
    return { authorizationId, expiresAt: new Date(expiresAt).toISOString(),
      network: networkName, chainId: network.chainId, mode, account: wallet.address,
      expectedAddress, constructorArgs: [String(network.chainId)],
      artifactSha256: ARTIFACT_SHA256,
      runtimeBytecodeSha256: digestHex(expectedRuntimeCode(network.chainId)),
      deployGas: deployGas.toString(), maximumGas: maximumGas.toString(),
      gasPriceWei: gasPrice.toString(), maximumCostWei: maximumCost.toString(),
      maximumCostBnb: formatEther(maximumCost), balanceBnb: formatEther(balance),
      candidate: candidate ? { cardId: candidate.cardId,
        profileHash: candidate.profileHash, stateSha256: candidate.stateSha256,
        manifestBytes: candidate.manifestBytes, stateBytes: candidate.stateBytes } : null,
      confirmationPhrase: networkName === 'mainnet' ? MAINNET_PHRASE : TESTNET_PHRASE,
      rollback: '合约部署和成功发布均不可回滚；只能停止使用该地址并部署新版本。' };
  }

  publishArgs(manifest, state, commitments) {
    return [`0x${manifest.toString('hex')}`, `0x${state.toString('hex')}`,
      commitments.profileHash, commitments.stateKey,
      commitments.parentRegistry, commitments.parentCardId,
      commitments.profileSchemaVersion, commitments.profileRevision];
  }

  async freshInstall(manifest, state) {
    const temporary = await mkdtemp(join(tmpdir(), 'flap-registry-v4-web-'));
    try {
      const input = join(temporary, 'cartridge');
      const output = join(temporary, 'installed');
      await mkdir(input);
      await Promise.all([
        writeFile(join(input, 'cartridge.json'), manifest, { flag: 'wx' }),
        writeFile(join(input, 'state.bin'), state, { flag: 'wx' }),
      ]);
      const installed = await this.deck.runV4(this.deck.brain.python,
        ['install', input, '--out', output]);
      if (!existsSync(join(output, 'service.npz'))) throw new Error('恢复卡带未生成 checkpoint');
      return { verified: true, fixedBootProbe: installed.fixedBootProbe };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async execute({ authorizationId, password, confirmationPhrase }) {
    const authorization = this.authorizations.get(authorizationId);
    if (!authorization || authorization.state !== 'ready') {
      throw new Error('Registry V4 授权不存在、已使用或正在执行');
    }
    if (this.now() > authorization.expiresAt) {
      this.authorizations.delete(authorizationId);
      throw new Error('Registry V4 授权已过期，请重新预览');
    }
    const expectedPhrase = authorization.network === 'mainnet' ? MAINNET_PHRASE : TESTNET_PHRASE;
    if (confirmationPhrase !== expectedPhrase) throw new Error('Registry V4 确认短语不正确');
    const wallet = await this.wallet.status();
    if (!wallet.exists || wallet.address.toLowerCase() !== authorization.account.toLowerCase()) {
      throw new Error('本地钱包与预览授权不一致');
    }
    const network = networkFor(authorization.network);
    const client = publicClient(network);
    await this.assertNetwork(client, network);
    authorization.state = 'signing';
    const result = { network: authorization.network, chainId: network.chainId,
      address: authorization.expectedAddress, deploymentTx: null,
      publicationTx: null, cardId: authorization.cardId, recovered: false,
      freshInstall: null };
    try {
      let address = authorization.expectedAddress;
      if (authorization.mode !== 'publish') {
        const deployGas = authorization.deployGas +
          authorization.deployGas * DEPLOY_GAS_BUFFER_PERCENT / 100n;
        const hash = await this.wallet.deployContract(password, {
          network: authorization.network, abi: artifact.abi,
          bytecode: artifact.bytecode, args: [BigInt(network.chainId)], gas: deployGas });
        const receipt = await client.waitForTransactionReceipt({ hash,
          confirmations: network.confirmations });
        if (receipt.status !== 'success' || !receipt.contractAddress ||
            receipt.contractAddress.toLowerCase() !== address.toLowerCase()) {
          throw new Error('Registry V4 部署回执与预览地址不一致');
        }
        const code = await this.assertDeployment(client, network, address);
        result.deploymentTx = hash;
        await this.writeDeployment(authorization.network, {
          address, chainId: network.chainId, deploymentTx: hash,
          deploymentBlock: receipt.blockNumber.toString(),
          deployer: wallet.address, deployedAt: new Date().toISOString(),
          artifactSha256: ARTIFACT_SHA256,
          runtimeBytecodeSha256: digestHex(code),
        });
      } else {
        await this.assertDeployment(client, network, address);
      }

      if (authorization.mode !== 'deploy') {
        const value = await this.deck.registryV4Candidate();
        const commitments = parseManifestCommitments(value.manifest, value.state);
        if (value.marker.id !== authorization.exportId ||
            commitments.cardId.toLowerCase() !== authorization.cardId.toLowerCase()) {
          throw new Error('预览后导出卡带已变化，请重新预览');
        }
        const args = this.publishArgs(value.manifest, value.state, commitments);
        const estimate = await client.estimateContractGas({ address,
          abi: artifact.abi, functionName: 'publish', account: wallet.address, args });
        if (estimate > PUBLICATION_GAS_BUDGET) throw new Error('卡带发布 Gas 超过安全预算');
        const hash = await this.wallet.writeContract(password, {
          network: authorization.network, address, abi: artifact.abi,
          functionName: 'publish', args, gas: estimate + estimate / 5n });
        const receipt = await client.waitForTransactionReceipt({ hash,
          confirmations: network.confirmations });
        if (receipt.status !== 'success') throw new Error('Registry V4 卡带发布失败');
        result.publicationTx = hash;
        const recovered = await recoverV4({ rpc: network.rpc, address,
          cardId: commitments.cardId, chainId: network.chainId });
        if (!recovered.manifest.equals(value.manifest) || !recovered.state.equals(value.state)) {
          throw new Error('Registry V4 回读字节与本地导出不一致');
        }
        result.recovered = true;
        result.freshInstall = await this.freshInstall(recovered.manifest, recovered.state);
      }
      authorization.state = 'used';
      result.addressUrl = `${network.explorer}/address/${address}`;
      if (result.deploymentTx) result.deploymentTxUrl = `${network.explorer}/tx/${result.deploymentTx}`;
      if (result.publicationTx) result.publicationTxUrl = `${network.explorer}/tx/${result.publicationTx}`;
      return jsonClone(result);
    } catch (error) {
      authorization.state = result.deploymentTx ? 'used' : 'ready';
      error.registryV4PartialResult = jsonClone(result);
      throw error;
    }
  }
}

export const REGISTRY_V4_CONFIRMATION_PHRASES = Object.freeze({
  mainnet: MAINNET_PHRASE, testnet: TESTNET_PHRASE,
});
