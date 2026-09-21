// Explicit one-shot deployment. The private key is read only from the process environment.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, http } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { expectedRuntimeCode } from './fly_cartridge_v4_chain_read.mjs';
import { loadDeploymentPrivateKey } from './registry-v4-deployer-key.mjs';

const root = path.resolve(import.meta.dirname, '..');
const artifactPath = path.join(root, 'artifacts/fly-cartridge-v4-registry-candidate.json');
const artifactBytes = fs.readFileSync(artifactPath);
const artifact = JSON.parse(artifactBytes);
const network = process.argv.includes('--chain') ? process.argv[process.argv.indexOf('--chain') + 1] : null;
if (!['testnet', 'mainnet'].includes(network)) throw new Error('Pass --chain testnet or --chain mainnet');
if (network === 'testnet' && !process.argv.includes('--confirm-testnet')) {
  throw new Error('Testnet deployment requires --confirm-testnet');
}
if (network === 'mainnet' && (!process.argv.includes('--confirm-mainnet') ||
    process.env.FLAP_REGISTRY_V4_MAINNET_ACK !== 'DEPLOY_IMMUTABLE_V4_MAINNET')) {
  throw new Error('Mainnet requires --confirm-mainnet and FLAP_REGISTRY_V4_MAINNET_ACK');
}
let privateKey = await loadDeploymentPrivateKey();
const chain = network === 'mainnet' ? bsc : bscTestnet;
const defaultRpc = network === 'mainnet' ? 'https://bsc-dataseed.bnbchain.org' :
  'https://bsc-testnet-dataseed.bnbchain.org';
const rpc = process.env[network === 'mainnet' ? 'BSC_RPC_URL' : 'BSC_TESTNET_RPC_URL'] || defaultRpc;
const expectedGenesis = network === 'mainnet' ?
  '0x0d21840abff46b96c84b2ac9e10e4f5cdaeb5693cb665db62a2f3b02d2d57b5b' :
  '0x6d3c66c5357ec91d5c43af47e234a939b22557cbb552dc45bebbceeed90fbe34';
const publicClient = createPublicClient({ chain, transport: http(rpc) });
if (await publicClient.getChainId() !== chain.id ||
    (await publicClient.getBlock({ blockNumber: 0n })).hash?.toLowerCase() !== expectedGenesis) {
  throw new Error(`RPC is not BSC ${network}`);
}
let secret = privateKey;
privateKey = null;
try {
  const account = privateKeyToAccount(secret);
  const balance = await publicClient.getBalance({ address: account.address });
  const estimatedGas = await publicClient.estimateContractGas({
    account: account.address, abi: artifact.abi, bytecode: artifact.bytecode,
    args: [BigInt(chain.id)],
  });
  const fees = await publicClient.estimateFeesPerGas();
  const gasPrice = fees.gasPrice ?? fees.maxFeePerGas;
  const estimatedCost = gasPrice ? estimatedGas * gasPrice : null;
  if (estimatedCost !== null && balance < estimatedCost) {
    throw new Error(`Deployment wallet ${account.address} lacks gas funds`);
  }
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  const transactionHash = await wallet.deployContract({
    account, abi: artifact.abi, bytecode: artifact.bytecode,
    args: [BigInt(chain.id)], gas: estimatedGas + estimatedGas / 5n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash,
    confirmations: network === 'mainnet' ? 5 : 2 });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Registry V4 deployment failed');
  const code = await publicClient.getBytecode({ address: receipt.contractAddress });
  if (!code || code.toLowerCase() !== expectedRuntimeCode(chain.id).toLowerCase()) {
    throw new Error('Deployed Registry V4 runtime bytecode mismatch');
  }
  console.log(JSON.stringify({
    network, chainId: chain.id, deployer: account.address,
    address: receipt.contractAddress, deploymentTx: transactionHash,
    deploymentBlock: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(),
    artifactSha256: crypto.createHash('sha256').update(artifactBytes).digest('hex'),
    runtimeBytecodeSha256: crypto.createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex'),
  }, null, 2));
} finally {
  secret = null;
}
