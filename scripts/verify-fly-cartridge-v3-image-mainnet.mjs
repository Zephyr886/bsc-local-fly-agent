// Independent, read-only verification after the local wallet deploys and mints on BSC mainnet.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, decodeFunctionData, encodeDeployData, http,
  isAddress } from 'viem';
import { bsc } from 'viem/chains';

const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const address = arg('--address');
const deploymentTx = arg('--deployment-tx');
const mintTx = arg('--mint-tx');
const rpc = arg('--rpc') || 'https://bsc-dataseed.bnbchain.org';
if (!isAddress(address || '') || !/^0x[0-9a-fA-F]{64}$/.test(deploymentTx || '') ||
    !/^0x[0-9a-fA-F]{64}$/.test(mintTx || '')) {
  throw new Error('Pass --address, --deployment-tx and --mint-tx');
}
const root = path.resolve(import.meta.dirname, '..');
const artifact = JSON.parse(fs.readFileSync(path.join(root,
  'artifacts/fly-cartridge-v3-image-candidate.json')));
const cover = fs.readFileSync(path.join(root,
  'public/nft/fly-cartridge-v3-0ec7c8477b27.png'));
const sha = (bytes) => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const coverHash = '0x0ec7c8477b27bba1441466c67140bf9e0aadeec06bfa26b1194466b64ca2b9f1';
const coverUrl = 'https://flaptofly.com/nft/fly-cartridge-v3-0ec7c8477b27.png';
const genesis = '0x0d21840abff46b96c84b2ac9e10e4f5cdaeb5693cb665db62a2f3b02d2d57b5b';
assert.equal(sha(cover), coverHash);

let expected = artifact.deployedBytecode.slice(2).toLowerCase();
const chain = BigInt(56).toString(16).padStart(64, '0');
const refs = Object.values(artifact.immutableReferences).flat();
assert.ok(refs.length > 0);
for (const ref of refs) {
  assert.equal(ref.length, 32);
  const at = ref.start * 2;
  expected = `${expected.slice(0, at)}${chain}${expected.slice(at + 64)}`;
}
expected = `0x${expected}`;
const client = createPublicClient({ chain: bsc, transport: http(rpc, { timeout: 15_000 }) });
assert.equal(await client.getChainId(), 56);
assert.ok(same((await client.getBlock({ blockNumber: 0n })).hash, genesis));

const [deployed, deployment, code, chainId, uri, imageSha] = await Promise.all([
  client.getTransaction({ hash: deploymentTx }),
  client.getTransactionReceipt({ hash: deploymentTx }),
  client.getBytecode({ address }),
  client.readContract({ address, abi: artifact.abi, functionName: 'deploymentChainId' }),
  client.readContract({ address, abi: artifact.abi, functionName: 'COVER_URL' }),
  client.readContract({ address, abi: artifact.abi, functionName: 'COVER_SHA256' }),
]);
assert.equal(deployment.status, 'success');
assert.ok(deployment.contractAddress && same(deployment.contractAddress, address));
assert.equal(deployed.to, null);
assert.ok(same(deployed.input, encodeDeployData({ abi: artifact.abi,
  bytecode: artifact.bytecode, args: [56n] })));
assert.ok(code && same(code, expected));
assert.equal(chainId, 56n);
assert.equal(uri, coverUrl);
assert.ok(same(imageSha, coverHash));

const [published, mintReceipt] = await Promise.all([
  client.getTransaction({ hash: mintTx }),
  client.getTransactionReceipt({ hash: mintTx }),
]);
assert.equal(mintReceipt.status, 'success');
assert.ok(published.to && same(published.to, address));
const call = decodeFunctionData({ abi: artifact.abi, data: published.input });
assert.equal(call.functionName, 'publish');
const [manifestHex, stateHex, stateKey, parentCardId] = call.args;
const manifest = Buffer.from(manifestHex.slice(2), 'hex');
const state = Buffer.from(stateHex.slice(2), 'hex');
const cardId = sha(manifest);
const stateSha256 = sha(state);
const parsed = JSON.parse(manifest.toString('utf8'));
assert.equal(parsed.format, 'fly-cartridge');
assert.equal(parsed.formatVersion, 3);
assert.equal(parsed.state?.bytes, state.length);
assert.ok(same(`0x${parsed.state?.sha256}`, stateSha256));
assert.ok(same(`0x${parsed.traitKey}`, stateKey));
const [card, tokenId] = await Promise.all([
  client.readContract({ address, abi: artifact.abi, functionName: 'card', args: [cardId] }),
  client.readContract({ address, abi: artifact.abi,
    functionName: 'tokenByCardId', args: [cardId] }),
]);
assert.ok(tokenId > 0n && card.tokenId === tokenId);
assert.ok(same(card.creator, published.from));
assert.ok(same(card.stateSha256, stateSha256));
assert.ok(same(card.stateKey, stateKey));
assert.ok(same(card.parentCardId, parentCardId));
assert.equal(Number(card.manifestLength), manifest.length);
assert.equal(Number(card.stateLength), state.length);
const tokenURI = await client.readContract({ address, abi: artifact.abi,
  functionName: 'tokenURI', args: [tokenId] });
const prefix = 'data:application/json;base64,';
assert.ok(tokenURI.startsWith(prefix));
const metadata = JSON.parse(Buffer.from(tokenURI.slice(prefix.length), 'base64').toString('utf8'));
assert.equal(metadata.name, `Fly Cartridge #${tokenId}`);
assert.equal(metadata.image, coverUrl);
assert.ok(metadata.attributes.some((item) => item.trait_type === 'cardId' && same(item.value, cardId)));
assert.ok(metadata.attributes.some((item) => item.trait_type === 'coverSha256' && same(item.value, coverHash)));

const response = await fetch(coverUrl, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
assert.equal(response.status, 200);
assert.ok(response.headers.get('content-type')?.includes('image/png'));
const hosted = Buffer.from(await response.arrayBuffer());
assert.ok(hosted.equals(cover));
assert.equal(sha(hosted), coverHash);
console.log(JSON.stringify({ address, deploymentTx, mintTx, cardId,
  tokenId: tokenId.toString(), owner: await client.readContract({ address,
    abi: artifact.abi, functionName: 'ownerOf', args: [tokenId] }),
  manifestBytes: manifest.length, stateBytes: state.length,
  image: coverUrl, imageSha256: coverHash,
  deploymentGas: deployment.gasUsed.toString(), mintGas: mintReceipt.gasUsed.toString(),
  verified: true }));
