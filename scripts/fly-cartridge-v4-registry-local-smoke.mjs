// Local EVM deployment, invariant and publish/recover smoke proof for Registry V4.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { expectedRuntimeCode, parseManifestCommitments,
  recoverV4 } from './fly_cartridge_v4_chain_read.mjs';

if (!process.argv.includes('--local')) throw new Error('Explicit --local required');
const root = path.resolve(import.meta.dirname, '..');
const artifact = JSON.parse(fs.readFileSync(path.join(root,
  'artifacts/fly-cartridge-v4-registry-candidate.json')));
const rpc = process.env.FLY_V4_LOCAL_RPC || 'http://127.0.0.1:8545';
const client = createPublicClient({ transport: http(rpc) });
assert.equal(await client.getChainId(), 31337);
const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const wallet = createWalletClient({ account, transport: http(rpc) });
const zeroAddress = `0x${'00'.repeat(20)}`;
const zero = `0x${'00'.repeat(32)}`;
const profileA = `0x${'11'.repeat(32)}`;
const profileB = `0x${'12'.repeat(32)}`;
const stateKey = `0x${'22'.repeat(32)}`;
const state = '0x01020304';
const stateBytes = Buffer.from(state.slice(2), 'hex');
const sha = (value) => `0x${crypto.createHash('sha256').update(
  Buffer.from(value.slice(2), 'hex')).digest('hex')}`;
const makeManifest = ({ profileHash, revision, parentRegistry = null,
  parentCardId = null }) => Buffer.from(`${JSON.stringify({
  format: 'fly-cartridge', formatVersion: 4,
  fly: { profileHash: `sha256:${profileHash.slice(2)}`,
    profileSchemaVersion: 1, profileRevision: revision },
  traitKey: `sha256:${stateKey.slice(2)}`,
  state: { bytes: stateBytes.length,
    sha256: crypto.createHash('sha256').update(stateBytes).digest('hex') },
  lineage: { parentRegistry, parentCardId },
})}\n`);

await assert.rejects(wallet.deployContract({ abi: artifact.abi,
  bytecode: artifact.bytecode, args: [56n] }));
const deploymentHash = await wallet.deployContract({ abi: artifact.abi,
  bytecode: artifact.bytecode, args: [31337n] });
const deployment = await client.waitForTransactionReceipt({ hash: deploymentHash });
assert.equal(deployment.status, 'success');
const address = deployment.contractAddress;
assert.ok(address);
assert.equal((await client.getBytecode({ address })).toLowerCase(),
  expectedRuntimeCode(31337).toLowerCase());

const publish = async (args) => {
  const hash = await wallet.writeContract({ address, abi: artifact.abi,
    functionName: 'publish', args, account });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  return receipt;
};
const manifestABytes = makeManifest({ profileHash: profileA, revision: 1 });
const manifestA = `0x${manifestABytes.toString('hex')}`;
const base = [manifestA, state, profileA, stateKey, zeroAddress, zero, 1, 1];
const first = await publish(base);
const firstCardId = sha(manifestA);
const firstCard = await client.readContract({ address, abi: artifact.abi,
  functionName: 'card', args: [firstCardId] });
assert.equal(firstCard.profileHash, profileA);
assert.equal(firstCard.tokenId, 1n);

const duplicateManifestBytes = makeManifest({ profileHash: profileA, revision: 2 });
const duplicateManifest = `0x${duplicateManifestBytes.toString('hex')}`;
await assert.rejects(wallet.writeContract({ address, abi: artifact.abi,
  functionName: 'publish', args: base, account }));
await assert.rejects(wallet.writeContract({ address, abi: artifact.abi,
  functionName: 'publish', args: [duplicateManifest, state, profileA, stateKey,
    zeroAddress, zero, 1, 2], account }));
await assert.rejects(wallet.writeContract({ address, abi: artifact.abi,
  functionName: 'publish', args: [duplicateManifest, state, profileB, stateKey,
    address, zero, 1, 2], account }));

const manifestBBytes = makeManifest({ profileHash: profileB, revision: 2,
  parentRegistry: address, parentCardId: firstCardId });
const manifestB = `0x${manifestBBytes.toString('hex')}`;
const second = await publish([manifestB, state, profileB, stateKey,
  address, firstCardId, 1, 2]);
const secondCardId = sha(manifestB);
const secondCard = await client.readContract({ address, abi: artifact.abi,
  functionName: 'card', args: [secondCardId] });
assert.equal(secondCard.tokenId, 2n);
assert.equal(secondCard.parentRegistry.toLowerCase(), address.toLowerCase());
assert.equal(secondCard.parentCardId, firstCardId);
const uri = await client.readContract({ address, abi: artifact.abi,
  functionName: 'tokenURI', args: [2n] });
assert.ok(uri.startsWith('data:application/json;base64,'));
const metadata = JSON.parse(Buffer.from(
  uri.slice('data:application/json;base64,'.length), 'base64').toString('utf8'));
assert.equal(metadata.name, 'Fly Cartridge V4 2');
assert.equal(metadata.image, 'https://flaptofly.com/nft/fly-cartridge-v3-0ec7c8477b27.png');
assert.equal(metadata.attributes[0].value, secondCardId);
assert.deepEqual(metadata.attributes.at(-1), {
  trait_type: 'coverSha256',
  value: '0x0ec7c8477b27bba1441466c67140bf9e0aadeec06bfa26b1194466b64ca2b9f1',
});
const recovered = await recoverV4({ address, cardId: secondCardId,
  chainId: 31337, client });
assert.deepEqual(recovered.manifest, manifestBBytes);
assert.deepEqual(recovered.state, stateBytes);
assert.deepEqual(parseManifestCommitments(recovered.manifest, recovered.state),
  parseManifestCommitments(manifestBBytes, stateBytes));

console.log(JSON.stringify({
  address, deploymentTx: deploymentHash, deploymentGas: deployment.gasUsed.toString(),
  firstPublishGas: first.gasUsed.toString(), secondPublishGas: second.gasUsed.toString(),
  duplicateCardRejected: true, duplicateContentRejected: true,
  malformedParentRejected: true, sameStateDifferentProfileAllowed: true,
  localParentAccepted: true, tokenMetadataVerified: true,
  publishCalldataRecoveryVerified: true,
}));
