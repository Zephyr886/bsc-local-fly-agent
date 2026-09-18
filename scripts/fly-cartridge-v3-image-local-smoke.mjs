// Local-only deployment and mint proof for the illustrated v3 collection.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

if (!process.argv.includes('--local')) throw new Error('Explicit --local required');
const root = path.resolve(import.meta.dirname, '..');
const artifact = JSON.parse(fs.readFileSync(path.join(root,
  'artifacts/fly-cartridge-v3-image-candidate.json')));
const cover = fs.readFileSync(path.join(root,
  'public/nft/fly-cartridge-v3-0ec7c8477b27.png'));
const sha = (bytes) => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const coverHash = '0x0ec7c8477b27bba1441466c67140bf9e0aadeec06bfa26b1194466b64ca2b9f1';
const coverUrl = 'https://flaptofly.com/nft/fly-cartridge-v3-0ec7c8477b27.png';
assert.equal(sha(cover), coverHash);

const folder = process.env.FLY_V3_SAMPLE_DIR ||
  path.resolve(root, '../work/fly-cartridge-v3-rc2-candidate');
const manifest = fs.readFileSync(path.join(folder, 'cartridge.json'));
const state = fs.readFileSync(path.join(folder, 'state.bin'));
const parsed = JSON.parse(manifest);
const cardId = sha(manifest);
const hex = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;
const zero = `0x${'00'.repeat(32)}`;
const rpc = 'http://127.0.0.1:8545';
const client = createPublicClient({ transport: http(rpc) });
assert.equal(await client.getChainId(), 31337);
const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const wallet = createWalletClient({ account, transport: http(rpc) });

await assert.rejects(wallet.deployContract({ abi: artifact.abi,
  bytecode: artifact.bytecode, args: [56n] }));
const hash = await wallet.deployContract({ abi: artifact.abi,
  bytecode: artifact.bytecode, args: [31337n] });
const deployment = await client.waitForTransactionReceipt({ hash });
assert.equal(deployment.status, 'success');
const address = deployment.contractAddress;
assert.ok(address);
assert.equal(await client.readContract({ address, abi: artifact.abi,
  functionName: 'COVER_URL' }), coverUrl);
assert.equal(await client.readContract({ address, abi: artifact.abi,
  functionName: 'COVER_SHA256' }), coverHash);
await assert.rejects(client.readContract({ address, abi: artifact.abi,
  functionName: 'tokenURI', args: [1n] }));

const args = [hex(manifest), hex(state), `0x${parsed.traitKey}`, zero];
const estimate = await client.estimateContractGas({ address, abi: artifact.abi,
  functionName: 'publish', args, account: account.address });
assert.ok(estimate < 16_777_216n);
const mintHash = await wallet.writeContract({ address, abi: artifact.abi,
  functionName: 'publish', args, gas: estimate + 100_000n });
const receipt = await client.waitForTransactionReceipt({ hash: mintHash });
assert.equal(receipt.status, 'success');
assert.equal(await client.readContract({ address, abi: artifact.abi,
  functionName: 'cardIdByToken', args: [1n] }), cardId);
const uri = await client.readContract({ address, abi: artifact.abi,
  functionName: 'tokenURI', args: [1n] });
assert.ok(uri.startsWith('data:application/json;base64,'));
const metadata = JSON.parse(Buffer.from(uri.slice('data:application/json;base64,'.length),
  'base64').toString('utf8'));
assert.equal(metadata.name, 'Fly Cartridge #1');
assert.equal(metadata.image, coverUrl);
assert.ok(metadata.description.includes('MaleCNS v1.0'));
assert.deepEqual(metadata.attributes, [
  { trait_type: 'cardId', value: cardId },
  { trait_type: 'coverSha256', value: coverHash },
]);
console.log(JSON.stringify({ address, cardId, image: metadata.image,
  imageSha256: coverHash, mintGas: receipt.gasUsed.toString(),
  deployed: true, minted: true, metadataImageVerified: true }));
