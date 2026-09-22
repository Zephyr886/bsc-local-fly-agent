import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  getAddress,
  getContractAddress,
  isAddress,
} from 'viem';
import { bsc, bscTestnet } from 'viem/chains';

const ARTIFACT = __FLAP_REGISTRY_V4_ARTIFACT__;
const ARTIFACT_SHA256 = __FLAP_REGISTRY_V4_ARTIFACT_SHA256__;
const TOOL_VERSION = __FLAP_TOOL_VERSION__;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 = `0x${'00'.repeat(32)}`;
const COVER_URL = 'https://flaptofly.com/nft/fly-cartridge-v3-0ec7c8477b27.png';
const COVER_SHA256 = '0x0ec7c8477b27bba1441466c67140bf9e0aadeec06bfa26b1194466b64ca2b9f1';
const NETWORKS = Object.freeze({
  testnet: {
    chain: bscTestnet,
    name: 'BSC Testnet',
    genesis: '0x6d3c66c5357ec91d5c43af47e234a939b22557cbb552dc45bebbceeed90fbe34',
    explorer: 'https://testnet.bscscan.com',
    confirmations: 2,
    deployPhrase: '确认部署官方测试网合约',
    testPhrase: '确认执行测试网卡带测试',
  },
  mainnet: {
    chain: bsc,
    name: 'BSC Mainnet',
    genesis: '0x0d21840abff46b96c84b2ac9e10e4f5cdaeb5693cb665db62a2f3b02d2d57b5b',
    explorer: 'https://bscscan.com',
    confirmations: 5,
    deployPhrase: '确认部署官方主网合约',
    testPhrase: '确认执行主网卡带测试',
  },
});

const byId = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'network', 'connect', 'account', 'chain', 'balance', 'artifact-hash', 'artifact-short',
  'tool-version', 'preview-deploy', 'deploy-preview', 'deploy-phrase', 'deploy-help', 'deploy',
  'registry-address', 'preview-test', 'test-preview', 'test-phrase', 'test-help', 'run-test',
  'status', 'result', 'download-report',
].map((id) => [id, byId(id)]));

let provider = null;
let publicClient = null;
let walletClient = null;
let account = null;
let selected = NETWORKS.testnet;
let deployAuthorization = null;
let testAuthorization = null;
let report = null;

const json = (value) => JSON.stringify(value, (_key, item) =>
  typeof item === 'bigint' ? item.toString() : item, 2);
const same = (left, right) => String(left).toLowerCase() === String(right).toLowerCase();
const percentGas = (gas) => gas + gas / 5n;
const cost = (gas, gasPrice) => gas * gasPrice;
const encoder = new TextEncoder();

function announce(message, error = false) {
  ui.status.textContent = message;
  ui.status.classList.toggle('error', error);
}

function errorMessage(error) {
  const detail = error?.shortMessage || error?.message || String(error);
  return detail.replace(/^.*?execution reverted(?::\s*)?/i, '链上拒绝：');
}

async function sha256Hex(bytes) {
  const value = bytes instanceof Uint8Array ? bytes : encoder.encode(bytes);
  const digest = await crypto.subtle.digest('SHA-256', value);
  return bytesToHex(new Uint8Array(digest));
}

function expectedRuntimeCode(chainId) {
  let code = ARTIFACT.deployedBytecode.slice(2).toLowerCase();
  const encodedChain = BigInt(chainId).toString(16).padStart(64, '0');
  for (const references of Object.values(ARTIFACT.immutableReferences)) {
    for (const reference of references) {
      if (reference.length !== 32) throw new Error('未知的 immutable 布局');
      const offset = reference.start * 2;
      code = code.slice(0, offset) + encodedChain + code.slice(offset + 64);
    }
  }
  return `0x${code}`;
}

function resetAuthorizations() {
  deployAuthorization = null;
  testAuthorization = null;
  ui.deploy.disabled = true;
  ui['run-test'].disabled = true;
  ui['deploy-preview'].textContent = '连接钱包后生成部署预览。';
  ui['test-preview'].textContent = '部署完成或填入官方地址后生成测试预览。';
  ui['deploy-phrase'].value = '';
  ui['test-phrase'].value = '';
}

function resetConnection(message = '钱包连接已变化，请重新连接。') {
  provider = null;
  publicClient = null;
  walletClient = null;
  account = null;
  ui.account.textContent = '未连接';
  ui.chain.textContent = '—';
  ui.balance.textContent = '—';
  resetAuthorizations();
  announce(message);
}

async function switchNetwork(injected, network) {
  const chainId = `0x${network.chain.id.toString(16)}`;
  try {
    await injected.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (error) {
    if (Number(error?.code) !== 4902) throw error;
    await injected.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId,
        chainName: network.chain.name,
        nativeCurrency: network.chain.nativeCurrency,
        rpcUrls: network.chain.rpcUrls.default.http,
        blockExplorerUrls: [network.explorer],
      }],
    });
  }
}

async function verifyChain(client, network) {
  const chainId = await client.getChainId();
  if (chainId !== network.chain.id) throw new Error(`钱包链错误：期望 ${network.chain.id}，实际 ${chainId}`);
  const genesis = await client.getBlock({ blockNumber: 0n });
  if (!same(genesis.hash, network.genesis)) throw new Error('创世区块不匹配，拒绝使用该 RPC');
}

async function refreshBalance() {
  const wei = await publicClient.getBalance({ address: account });
  ui.balance.textContent = `${formatEther(wei)} BNB`;
  return wei;
}

async function connect() {
  const injected = window.ethereum;
  if (!injected?.request) {
    throw new Error('没有检测到浏览器钱包。请用安装了 MetaMask/兼容钱包的 Chrome 或 Edge 打开此 HTML。');
  }
  selected = NETWORKS[ui.network.value];
  await switchNetwork(injected, selected);
  const accounts = await injected.request({ method: 'eth_requestAccounts' });
  if (!accounts?.[0]) throw new Error('钱包没有返回账户');
  provider = injected;
  account = getAddress(accounts[0]);
  publicClient = createPublicClient({ chain: selected.chain, transport: custom(provider) });
  walletClient = createWalletClient({ account, chain: selected.chain, transport: custom(provider) });
  await verifyChain(publicClient, selected);
  const balance = await refreshBalance();
  ui.account.textContent = account;
  ui.chain.textContent = `${selected.name} · ${selected.chain.id}`;
  resetAuthorizations();
  announce(`钱包已连接；当前余额 ${formatEther(balance)} BNB。`);
  provider.on?.('accountsChanged', () => resetConnection());
  provider.on?.('chainChanged', () => resetConnection());
}

function requireConnection() {
  if (!provider || !publicClient || !walletClient || !account) throw new Error('请先连接浏览器钱包');
}

async function officialRuntime(address) {
  if (!isAddress(address)) throw new Error('Registry 地址格式无效');
  const normalized = getAddress(address);
  const actual = await publicClient.getBytecode({ address: normalized });
  const expected = expectedRuntimeCode(selected.chain.id);
  if (!actual || !same(actual, expected)) throw new Error('该地址不是本 HTML 固定构建的 Registry V4');
  const [deploymentChainId, coverUrl, coverSha256] = await Promise.all([
    publicClient.readContract({ address: normalized, abi: ARTIFACT.abi,
      functionName: 'deploymentChainId' }),
    publicClient.readContract({ address: normalized, abi: ARTIFACT.abi,
      functionName: 'COVER_URL' }),
    publicClient.readContract({ address: normalized, abi: ARTIFACT.abi,
      functionName: 'COVER_SHA256' }),
  ]);
  if (deploymentChainId !== BigInt(selected.chain.id)) throw new Error('合约部署链标识不匹配');
  if (coverUrl !== COVER_URL || !same(coverSha256, COVER_SHA256)) {
    throw new Error('NFT 封面 URL 或 SHA-256 与固定构建不一致');
  }
  return { address: normalized, coverUrl, coverSha256,
    runtimeSha256: await sha256Hex(new Uint8Array(
      expected.slice(2).match(/.{2}/g).map((item) => Number.parseInt(item, 16)))) };
}

function tokenMetadata(uri) {
  const prefix = 'data:application/json;base64,';
  if (typeof uri !== 'string' || !uri.startsWith(prefix)) throw new Error('NFT tokenURI 不是内嵌 Base64 JSON');
  try { return JSON.parse(atob(uri.slice(prefix.length))); }
  catch { throw new Error('NFT tokenURI metadata 无法解析'); }
}

async function previewDeploy() {
  requireConnection();
  await verifyChain(publicClient, selected);
  const deployData = encodeDeployData({
    abi: ARTIFACT.abi,
    bytecode: ARTIFACT.bytecode,
    args: [BigInt(selected.chain.id)],
  });
  const [estimatedGas, gasPrice, nonce, balance] = await Promise.all([
    publicClient.estimateGas({ account, data: deployData }),
    publicClient.getGasPrice(),
    publicClient.getTransactionCount({ address: account, blockTag: 'pending' }),
    publicClient.getBalance({ address: account }),
  ]);
  const gasLimit = percentGas(estimatedGas);
  const maximumCost = cost(gasLimit, gasPrice);
  if (balance < maximumCost) throw new Error(`余额不足：预算 ${formatEther(maximumCost)} BNB`);
  const expectedAddress = getContractAddress({ from: account, nonce: BigInt(nonce) });
  deployAuthorization = {
    network: ui.network.value,
    account,
    nonce,
    expectedAddress,
    gasLimit,
    gasPrice,
    maximumCost,
    phrase: selected.deployPhrase,
  };
  ui['deploy-preview'].textContent = json({
    operation: 'DEPLOY_OFFICIAL_REGISTRY_V4',
    network: selected.name,
    chainId: selected.chain.id,
    deployer: account,
    expectedAddress,
    pendingNonce: nonce,
    estimatedGas,
    gasLimit,
    gasPriceWei: gasPrice,
    maximumCostBNB: formatEther(maximumCost),
    creationBytes: (ARTIFACT.bytecode.length - 2) / 2,
    runtimeBytes: (ARTIFACT.deployedBytecode.length - 2) / 2,
    artifactSha256: ARTIFACT_SHA256,
    coverUrl: COVER_URL,
    coverSha256: COVER_SHA256,
    confirmations: selected.confirmations,
  });
  ui['deploy-help'].textContent = `请输入：${selected.deployPhrase}`;
  ui.deploy.disabled = false;
  announce('部署预览已冻结。发送前会再次核对账户、网络与 nonce。');
}

async function deploy() {
  requireConnection();
  if (!deployAuthorization) throw new Error('请先生成部署预览');
  if (ui['deploy-phrase'].value !== deployAuthorization.phrase) throw new Error('部署确认短语不正确');
  if (ui.network.value !== deployAuthorization.network || !same(account, deployAuthorization.account)) {
    throw new Error('网络或账户已变化，请重新预览');
  }
  await verifyChain(publicClient, selected);
  const nonce = await publicClient.getTransactionCount({ address: account, blockTag: 'pending' });
  if (nonce !== deployAuthorization.nonce) throw new Error('账户 nonce 已变化，请重新预览预计地址');
  ui.deploy.disabled = true;
  announce('等待钱包确认部署交易…');
  const transactionHash = await walletClient.deployContract({
    account,
    abi: ARTIFACT.abi,
    bytecode: ARTIFACT.bytecode,
    args: [BigInt(selected.chain.id)],
    gas: deployAuthorization.gasLimit,
  });
  announce(`部署交易已广播，等待 ${selected.confirmations} 个确认…`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: transactionHash,
    confirmations: selected.confirmations,
  });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Registry V4 部署失败');
  if (!same(receipt.contractAddress, deployAuthorization.expectedAddress)) throw new Error('部署地址与预览不一致');
  const verified = await officialRuntime(receipt.contractAddress);
  ui['registry-address'].value = verified.address;
  report = {
    toolVersion: TOOL_VERSION,
    artifactSha256: ARTIFACT_SHA256,
    network: selected.name,
    chainId: selected.chain.id,
    deployer: account,
    registryAddress: verified.address,
    deploymentTransaction: transactionHash,
    deploymentBlock: receipt.blockNumber,
    deploymentGasUsed: receipt.gasUsed,
    runtimeSha256: verified.runtimeSha256,
    coverUrl: verified.coverUrl,
    coverSha256: verified.coverSha256,
    explorer: `${selected.explorer}/tx/${transactionHash}`,
    verifiedAt: new Date().toISOString(),
  };
  ui.result.textContent = json(report);
  ui['download-report'].disabled = false;
  deployAuthorization = null;
  await refreshBalance();
  announce('官方 Registry V4 已部署，运行字节码与固定构建逐字节一致。');
}

async function createTestCandidate(registryAddress) {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const stateBytes = crypto.getRandomValues(new Uint8Array(64));
  const nonce = bytesToHex(nonceBytes).slice(2);
  const profileHash = await sha256Hex('flap-registry-v4-official-test-profile:v1');
  const stateKey = await sha256Hex(`flap-registry-v4-test-state:${nonce}`);
  const stateSha256 = await sha256Hex(stateBytes);
  const manifest = {
    format: 'fly-cartridge',
    formatVersion: 4,
    purpose: 'registry-v4-official-deployment-test',
    test: { nonce, createdAt: new Date().toISOString(), chainId: selected.chain.id, registryAddress },
    fly: { profileHash: `sha256:${profileHash.slice(2)}`, profileSchemaVersion: 1, profileRevision: 1 },
    traitKey: `sha256:${stateKey.slice(2)}`,
    state: { bytes: stateBytes.length, sha256: stateSha256.slice(2) },
    lineage: { parentRegistry: ZERO_ADDRESS, parentCardId: ZERO_BYTES32 },
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  return {
    nonce,
    manifest,
    manifestHex: bytesToHex(manifestBytes),
    stateHex: bytesToHex(stateBytes),
    cardId: await sha256Hex(manifestBytes),
    profileHash,
    stateKey,
    stateSha256,
  };
}

async function previewTest() {
  requireConnection();
  await verifyChain(publicClient, selected);
  const registry = await officialRuntime(ui['registry-address'].value.trim());
  const candidate = await createTestCandidate(registry.address);
  const args = [
    candidate.manifestHex,
    candidate.stateHex,
    candidate.profileHash,
    candidate.stateKey,
    ZERO_ADDRESS,
    ZERO_BYTES32,
    1,
    1,
  ];
  const data = encodeFunctionData({ abi: ARTIFACT.abi, functionName: 'publish', args });
  const [estimatedGas, gasPrice, balance] = await Promise.all([
    publicClient.estimateGas({ account, to: registry.address, data }),
    publicClient.getGasPrice(),
    publicClient.getBalance({ address: account }),
  ]);
  const gasLimit = percentGas(estimatedGas);
  const maximumCost = cost(gasLimit, gasPrice);
  if (balance < maximumCost) throw new Error(`余额不足：测试预算 ${formatEther(maximumCost)} BNB`);
  testAuthorization = {
    network: ui.network.value,
    account,
    registry,
    candidate,
    args,
    data,
    estimatedGas,
    gasLimit,
    gasPrice,
    maximumCost,
    phrase: selected.testPhrase,
  };
  ui['test-preview'].textContent = json({
    operation: 'PUBLISH_ONE_TIME_TEST_CARTRIDGE',
    network: selected.name,
    chainId: selected.chain.id,
    registryAddress: registry.address,
    sender: account,
    cardId: candidate.cardId,
    profileHash: candidate.profileHash,
    stateKey: candidate.stateKey,
    stateSha256: candidate.stateSha256,
    manifestBytes: (candidate.manifestHex.length - 2) / 2,
    stateBytes: (candidate.stateHex.length - 2) / 2,
    estimatedGas,
    gasLimit,
    maximumCostBNB: formatEther(maximumCost),
    confirmations: selected.confirmations,
  });
  ui['test-help'].textContent = `请输入：${selected.testPhrase}`;
  ui['run-test'].disabled = false;
  announce('测试卡带预览已生成；内容只用于验证官方合约。');
}

async function runTest() {
  requireConnection();
  if (!testAuthorization) throw new Error('请先验证合约并生成测试预览');
  if (ui['test-phrase'].value !== testAuthorization.phrase) throw new Error('测试确认短语不正确');
  if (ui.network.value !== testAuthorization.network || !same(account, testAuthorization.account)) {
    throw new Error('网络或账户已变化，请重新预览');
  }
  await verifyChain(publicClient, selected);
  await officialRuntime(testAuthorization.registry.address);
  ui['run-test'].disabled = true;
  announce('等待钱包确认测试卡带发布…');
  const transactionHash = await walletClient.writeContract({
    account,
    address: testAuthorization.registry.address,
    abi: ARTIFACT.abi,
    functionName: 'publish',
    args: testAuthorization.args,
    gas: testAuthorization.gasLimit,
  });
  announce(`测试交易已广播，等待 ${selected.confirmations} 个确认…`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: transactionHash,
    confirmations: selected.confirmations,
  });
  if (receipt.status !== 'success') throw new Error('测试卡带发布失败');
  const tokenId = await publicClient.readContract({
    address: testAuthorization.registry.address,
    abi: ARTIFACT.abi,
    functionName: 'tokenByCardId',
    args: [testAuthorization.candidate.cardId],
  });
  if (tokenId === 0n) throw new Error('链上没有登记测试 Card');
  const [owner, card, transaction, tokenUri] = await Promise.all([
    publicClient.readContract({ address: testAuthorization.registry.address, abi: ARTIFACT.abi,
      functionName: 'ownerOf', args: [tokenId] }),
    publicClient.readContract({ address: testAuthorization.registry.address, abi: ARTIFACT.abi,
      functionName: 'card', args: [testAuthorization.candidate.cardId] }),
    publicClient.getTransaction({ hash: transactionHash }),
    publicClient.readContract({ address: testAuthorization.registry.address, abi: ARTIFACT.abi,
      functionName: 'tokenURI', args: [tokenId] }),
  ]);
  if (!same(owner, account) || !same(card.creator, account) ||
      !same(card.profileHash, testAuthorization.candidate.profileHash) ||
      !same(card.stateKey, testAuthorization.candidate.stateKey) ||
      !same(card.stateSha256, testAuthorization.candidate.stateSha256)) {
    throw new Error('Card/NFT 回读与测试输入不一致');
  }
  const decoded = decodeFunctionData({ abi: ARTIFACT.abi, data: transaction.input });
  if (decoded.functionName !== 'publish' ||
      !same(decoded.args[0], testAuthorization.candidate.manifestHex) ||
      !same(decoded.args[1], testAuthorization.candidate.stateHex)) {
    throw new Error('成功交易 calldata 与测试卡带不一致');
  }
  let duplicateRejected = false;
  try {
    await publicClient.estimateGas({ account, to: testAuthorization.registry.address, data: testAuthorization.data });
  } catch {
    duplicateRejected = true;
  }
  if (!duplicateRejected) throw new Error('重复卡带预检查未按预期拒绝');
  const metadata = tokenMetadata(tokenUri);
  const coverAttribute = Array.isArray(metadata.attributes)
    ? metadata.attributes.find((item) => item?.trait_type === 'coverSha256') : null;
  if (metadata.name !== `Fly Cartridge V4 ${tokenId}` || metadata.image !== COVER_URL ||
      !same(coverAttribute?.value, COVER_SHA256)) {
    throw new Error('NFT tokenURI 没有返回固定封面或封面哈希');
  }
  report = {
    ...(report || {
      toolVersion: TOOL_VERSION,
      artifactSha256: ARTIFACT_SHA256,
      network: selected.name,
      chainId: selected.chain.id,
      registryAddress: testAuthorization.registry.address,
    }),
    test: {
      publisher: account,
      transaction: transactionHash,
      block: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      cardId: testAuthorization.candidate.cardId,
      tokenId,
      owner,
      profileHash: testAuthorization.candidate.profileHash,
      stateKey: testAuthorization.candidate.stateKey,
      stateSha256: testAuthorization.candidate.stateSha256,
      image: metadata.image,
      coverSha256: coverAttribute.value,
      metadataImageVerified: true,
      calldataRecovered: true,
      duplicateRejected,
      explorer: `${selected.explorer}/tx/${transactionHash}`,
      verifiedAt: new Date().toISOString(),
    },
  };
  ui.result.textContent = json(report);
  ui['download-report'].disabled = false;
  testAuthorization = null;
  await refreshBalance();
  announce('测试卡带发布、NFT 图片元数据、Card 回读、calldata 恢复和重复拒绝均通过。');
}

function downloadReport() {
  if (!report) return;
  const blob = new Blob([`${json(report)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `flap-registry-v4-${report.chainId}-${report.registryAddress}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function guarded(action, button) {
  const original = button.textContent;
  button.disabled = true;
  try { await action(); }
  catch (error) { announce(errorMessage(error), true); }
  finally {
    if ((button === ui.deploy && deployAuthorization) ||
        (button === ui['run-test'] && testAuthorization) ||
        ![ui.deploy, ui['run-test']].includes(button)) button.disabled = false;
    button.textContent = original;
  }
}

ui['tool-version'].textContent = `v${TOOL_VERSION}`;
ui['artifact-hash'].textContent = ARTIFACT_SHA256;
ui['artifact-short'].textContent = `artifact ${ARTIFACT_SHA256.slice(0, 12)}…`;
ui.connect.addEventListener('click', () => guarded(connect, ui.connect));
ui['preview-deploy'].addEventListener('click', () => guarded(previewDeploy, ui['preview-deploy']));
ui.deploy.addEventListener('click', () => guarded(deploy, ui.deploy));
ui['preview-test'].addEventListener('click', () => guarded(previewTest, ui['preview-test']));
ui['run-test'].addEventListener('click', () => guarded(runTest, ui['run-test']));
ui['download-report'].addEventListener('click', downloadReport);
ui.network.addEventListener('change', () => resetConnection('目标网络已改变，请重新连接钱包。'));
ui['registry-address'].addEventListener('input', () => {
  testAuthorization = null;
  ui['run-test'].disabled = true;
});
