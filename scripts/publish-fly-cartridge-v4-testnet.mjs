// Publish, recover and fresh-install one v4 cartridge on the immutable testnet registry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPublicClient, createWalletClient, http, isAddress } from 'viem';
import { bscTestnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { expectedRuntimeCode, parseManifestCommitments,
  recoverV4 } from './fly_cartridge_v4_chain_read.mjs';
import { loadDeploymentPrivateKey } from './registry-v4-deployer-key.mjs';

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
if (!process.argv.includes('--confirm-testnet')) {
  throw new Error('Testnet publication requires --confirm-testnet');
}
const root = path.resolve(import.meta.dirname, '..');
const artifact = JSON.parse(fs.readFileSync(path.join(root,
  'artifacts/fly-cartridge-v4-registry-candidate.json')));
const address = arg('--address');
const cartridgeArgument = arg('--cartridge');
const cartridge = cartridgeArgument ? path.resolve(cartridgeArgument) : null;
if (!isAddress(address || '') || !cartridge || !fs.statSync(cartridge).isDirectory()) {
  throw new Error('Pass --address and --cartridge <directory>');
}
const manifest = fs.readFileSync(path.join(cartridge, 'cartridge.json'));
const state = fs.readFileSync(path.join(cartridge, 'state.bin'));
const commitments = parseManifestCommitments(manifest, state);
const rpc = process.env.BSC_TESTNET_RPC_URL ||
  'https://bsc-testnet-dataseed.bnbchain.org';
const client = createPublicClient({ chain: bscTestnet, transport: http(rpc) });
if (await client.getChainId() !== 97 ||
    (await client.getBlock({ blockNumber: 0n })).hash?.toLowerCase() !==
      '0x6d3c66c5357ec91d5c43af47e234a939b22557cbb552dc45bebbceeed90fbe34') {
  throw new Error('RPC is not BSC testnet');
}
const [code, deploymentChainId] = await Promise.all([
  client.getBytecode({ address }),
  client.readContract({ address, abi: artifact.abi,
    functionName: 'deploymentChainId' }),
]);
if (!code || code.toLowerCase() !== expectedRuntimeCode(97).toLowerCase() ||
    deploymentChainId !== 97n) throw new Error('Registry V4 testnet deployment mismatch');

let privateKey = await loadDeploymentPrivateKey();
try {
  const account = privateKeyToAccount(privateKey);
  const args = [
    `0x${manifest.toString('hex')}`, `0x${state.toString('hex')}`,
    commitments.profileHash, commitments.stateKey,
    commitments.parentRegistry, commitments.parentCardId,
    commitments.profileSchemaVersion, commitments.profileRevision,
  ];
  const gas = await client.estimateContractGas({ address, abi: artifact.abi,
    functionName: 'publish', args, account: account.address });
  const wallet = createWalletClient({ account, chain: bscTestnet, transport: http(rpc) });
  const transactionHash = await wallet.writeContract({ address, abi: artifact.abi,
    functionName: 'publish', args, account, gas: gas + gas / 5n });
  const receipt = await client.waitForTransactionReceipt({ hash: transactionHash,
    confirmations: 2 });
  if (receipt.status !== 'success') throw new Error('Registry V4 testnet publication failed');
  const recovered = await recoverV4({ rpc, address,
    cardId: commitments.cardId, chainId: 97 });
  assert.deepEqual(recovered.manifest, manifest);
  assert.deepEqual(recovered.state, state);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'flap-v4-testnet-loop-'));
  try {
    const recoveredDirectory = path.join(temporary, 'recovered');
    const installedDirectory = path.join(temporary, 'installed');
    fs.mkdirSync(recoveredDirectory);
    fs.writeFileSync(path.join(recoveredDirectory, 'cartridge.json'), recovered.manifest,
      { flag: 'wx' });
    fs.writeFileSync(path.join(recoveredDirectory, 'state.bin'), recovered.state,
      { flag: 'wx' });
    const python = process.env.FLAP_PYTHON || path.join(root, 'work',
      'full-brain-venv', 'Scripts', 'python.exe');
    const install = spawnSync(python,
      ['scripts/fly_cartridge_v4.py', 'install', recoveredDirectory,
        '--out', installedDirectory],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 180_000,
        env: process.env });
    if (install.status !== 0) {
      throw new Error(install.stderr.trim().split(/\r?\n/).at(-1) ||
        'Recovered cartridge fresh-install failed');
    }
    const installed = JSON.parse(install.stdout);
    if (!fs.existsSync(path.join(installedDirectory, 'service.npz'))) {
      throw new Error('Fresh install did not create service.npz');
    }
    console.log(JSON.stringify({
      network: 'testnet', chainId: 97, registry: address,
      publisher: account.address, transactionHash,
      blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(),
      cardId: commitments.cardId, tokenId: recovered.summary.tokenId,
      profileHash: commitments.profileHash, stateSha256: commitments.stateSha256,
      recoveredBytesMatch: true, freshInstallVerified: true,
      fixedBootProbe: installed.fixedBootProbe,
    }, null, 2));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
} finally {
  privateKey = null;
}
