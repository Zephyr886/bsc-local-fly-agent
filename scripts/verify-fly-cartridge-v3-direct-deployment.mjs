// Read-only check of the exact wallet-direct contract on BSC testnet or mainnet.
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, http, isAddress } from 'viem';
import { expectedRuntimeCode } from './fly_cartridge_v3_direct_chain_read.mjs';

const artifact = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,
  '../artifacts/fly-cartridge-v3-direct-candidate.json')));
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const address = arg('--address');
const deploymentTx = arg('--deployment-tx');
const network = arg('--chain') ?? 'testnet';
if (!['testnet', 'mainnet'].includes(network)) throw new Error('Use --chain testnet or mainnet');
const expectedChainId = network === 'mainnet' ? 56 : 97;
const expectedGenesis = network === 'mainnet' ?
  '0x0d21840abff46b96c84b2ac9e10e4f5cdaeb5693cb665db62a2f3b02d2d57b5b' :
  '0x6d3c66c5357ec91d5c43af47e234a939b22557cbb552dc45bebbceeed90fbe34';
const rpc = arg('--rpc') ?? (network === 'mainnet' ?
  'https://bsc-dataseed.bnbchain.org' : 'https://bsc-testnet-dataseed.bnbchain.org');
if (!isAddress(address) || !/^0x[0-9a-fA-F]{64}$/.test(deploymentTx ?? '')) {
  throw new Error('Pass --address and --deployment-tx');
}
const client = createPublicClient({ transport: http(rpc) });
const chainId = await client.getChainId();
if (chainId !== expectedChainId) throw new Error(`Wrong chain: ${chainId}`);
const genesis = (await client.getBlock({ blockNumber: 0n })).hash;
if (genesis?.toLowerCase() !== expectedGenesis) {
  throw new Error(`Wrong BSC ${network} genesis`);
}
const receipt = await client.getTransactionReceipt({ hash: deploymentTx });
if (receipt.status !== 'success' ||
    receipt.contractAddress?.toLowerCase() !== address.toLowerCase()) {
  throw new Error('Deployment receipt does not match contract address');
}
const [code, contractChainId, name, symbol] = await Promise.all([
  client.getBytecode({ address }),
  client.readContract({ address, abi: artifact.abi, functionName: 'deploymentChainId' }),
  client.readContract({ address, abi: artifact.abi, functionName: 'name' }),
  client.readContract({ address, abi: artifact.abi, functionName: 'symbol' }),
]);
if (!code || code.toLowerCase() !== expectedRuntimeCode(expectedChainId) ||
    contractChainId !== BigInt(expectedChainId) || name !== 'Fly Cartridge V3 Direct' ||
    symbol !== 'FLYCT') throw new Error('Contract identity or runtime bytecode mismatch');
console.log(JSON.stringify({ chainId, genesis, address,
  deploymentTx, deploymentGas: receipt.gasUsed.toString(),
  runtimeBytes: (code.length - 2) / 2, bytecodeMatched: true }, null, 2));
