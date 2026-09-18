// Run only against a local Hardhat node: node scripts/fly-cartridge-v3-direct-local-smoke.mjs --local
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, encodeFunctionData, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { recover } from './fly_cartridge_v3_direct_chain_read.mjs';

if (!process.argv.includes('--local')) throw new Error('Explicit --local required');
const root = path.resolve(import.meta.dirname, '..');
const artifact = JSON.parse(fs.readFileSync(path.join(root,
  'artifacts/fly-cartridge-v3-direct-candidate.json')));
const folder = process.env.FLY_V3_SAMPLE_DIR ||
  path.resolve(root, '../work/fly-cartridge-v3-rc2-candidate');
const manifest = fs.readFileSync(path.join(folder, 'cartridge.json'));
const state = fs.readFileSync(path.join(folder, 'state.bin'));
const parsed = JSON.parse(manifest);
const hex = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;
const sha = (bytes) => `0x${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const cardId = sha(manifest);
const rpc = 'http://127.0.0.1:8545';
const client = createPublicClient({ transport: http(rpc) });
assert.equal(await client.getChainId(), 31337);
const creator = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const other = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const wallet = createWalletClient({ account: creator, transport: http(rpc) });
await assert.rejects(wallet.deployContract({ abi: artifact.abi,
  bytecode: artifact.bytecode, args: [97n] }));
const deployed = await wallet.deployContract({ abi: artifact.abi,
  bytecode: artifact.bytecode, args: [31337n] });
const deployment = await client.waitForTransactionReceipt({ hash: deployed });
assert.equal(deployment.status, 'success');
const address = deployment.contractAddress;
assert.ok(address);
const zero = `0x${'00'.repeat(32)}`;
const args = [hex(manifest), hex(state), `0x${parsed.traitKey}`, zero];
const simulate = (callArgs, account = creator) =>
  client.simulateContract({ address, abi: artifact.abi,
    functionName: 'publish', args: callArgs, account: account.address });
await assert.rejects(simulate(['0x', ...args.slice(1)]));
await assert.rejects(simulate([args[0], '0x', ...args.slice(2)]));
await assert.rejects(simulate([...args.slice(0, 3), sha(Buffer.from('absent'))]));
await assert.rejects(simulate([args[0], args[1], zero, zero]));
const estimatedGas = await client.estimateContractGas({ address, abi: artifact.abi,
  functionName: 'publish', args, account: creator.address });
assert.ok(estimatedGas < 16_777_216n, 'Sample exceeds the BSC single-transaction cap');
const tx = await wallet.writeContract({ address, abi: artifact.abi,
  functionName: 'publish', args, gas: estimatedGas + 100_000n });
const receipt = await client.waitForTransactionReceipt({ hash: tx });
assert.equal(receipt.status, 'success');
assert.equal(receipt.logs.filter((log) => log.address.toLowerCase() === address.toLowerCase()).length, 2);
assert.equal(await client.readContract({ address, abi: artifact.abi,
  functionName: 'ownerOf', args: [1n] }), creator.address);
await assert.rejects(simulate(args));
await assert.rejects(simulate([hex(Buffer.from('different manifest')),
  args[1], args[2], zero]));
const restored = await recover({ rpc, address, cardId, chainId: 31337 });
assert.deepEqual(restored.manifest, manifest);
assert.deepEqual(restored.state, state);
const transfer = await wallet.writeContract({ address, abi: artifact.abi,
  functionName: 'transferFrom', args: [creator.address, other.address, 1n] });
assert.equal((await client.waitForTransactionReceipt({ hash: transfer })).status, 'success');
const afterTransfer = await recover({ rpc, address, cardId, chainId: 31337 });
assert.deepEqual(afterTransfer.state, state);
assert.equal(afterTransfer.summary.owner.toLowerCase(), other.address.toLowerCase());

// Contract maximums: high nonzero calldata cost and full 16 KiB manifest.
const largestManifest = Buffer.alloc(16_384, 0x61);
const largestState = Buffer.alloc(120_000 - largestManifest.length, 0x5a);
const maxArgs = [hex(largestManifest), hex(largestState), sha(Buffer.from('max-trait')), zero];
const maxCalldataBytes = (encodeFunctionData({ abi: artifact.abi,
  functionName: 'publish', args: maxArgs }).length - 2) / 2;
assert.ok(maxCalldataBytes < 128 * 1024 - 1_000,
  'Maximum encoded call leaves insufficient room for the signed transaction envelope');
const maxEstimate = await client.estimateContractGas({ address, abi: artifact.abi,
  functionName: 'publish', args: maxArgs, account: creator.address });
assert.ok(maxEstimate < 16_777_216n, 'Maximum cartridge exceeds BSC transaction cap');
const maxTx = await wallet.writeContract({ address, abi: artifact.abi,
  functionName: 'publish', args: maxArgs, gas: maxEstimate + 100_000n });
const maxReceipt = await client.waitForTransactionReceipt({ hash: maxTx });
assert.equal(maxReceipt.status, 'success');
await assert.rejects(simulate([hex(Buffer.alloc(16_385, 0x61)),
  args[1], sha(Buffer.from('too-long-manifest')), zero]));
await assert.rejects(simulate([hex(Buffer.from('too-long-state')),
  hex(Buffer.alloc(120_001, 0x5a)), sha(Buffer.from('too-long-state')), zero]));
console.log(JSON.stringify({ address, cardId, sampleBytes: state.length,
  sampleGas: receipt.gasUsed.toString(), sampleEstimate: estimatedGas.toString(),
  maxManifestBytes: largestManifest.length, maxStateBytes: largestState.length,
  maxCalldataBytes,
  maxGas: maxReceipt.gasUsed.toString(), maxEstimate: maxEstimate.toString(),
  singleTransaction: true, recovered: true, transferred: true }));
