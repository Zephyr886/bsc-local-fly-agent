// Read-only inspection of a candidate image registry and its first NFT on BSC mainnet.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, decodeFunctionData, http, isAddress } from 'viem';
import { bsc } from 'viem/chains';

const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const address = flag('--address');
const rpc = flag('--rpc') || 'https://bsc-dataseed.bnbchain.org';
if (!isAddress(address || '')) throw new Error('Use --address 0x...');
const root = path.resolve(import.meta.dirname, '..');
const artifact = JSON.parse(fs.readFileSync(path.join(root,
  'artifacts/fly-cartridge-v3-image-candidate.json')));
const client = createPublicClient({ chain: bsc, transport: http(rpc, { timeout: 15_000 }) });
const chainId = await client.getChainId();
const genesis = (await client.getBlock({ blockNumber: 0n })).hash;
assert.equal(chainId, 56);
assert.equal(genesis?.toLowerCase(),
  '0x0d21840abff46b96c84b2ac9e10e4f5cdaeb5693cb665db62a2f3b02d2d57b5b');
const code = await client.getBytecode({ address });
assert.ok(code && code !== '0x', 'No deployed contract at address');
let expected = artifact.deployedBytecode.slice(2).toLowerCase();
for (const ref of Object.values(artifact.immutableReferences).flat()) {
  assert.equal(ref.length, 32);
  const at = ref.start * 2;
  expected = expected.slice(0, at) + BigInt(56).toString(16).padStart(64, '0') +
    expected.slice(at + 64);
}
assert.equal(code.toLowerCase(), `0x${expected}`, 'Contract differs from image candidate');
const read = (functionName, args = []) => client.readContract({ address,
  abi: artifact.abi, functionName, args });
const [coverUrl, coverHash, name, nextTokenId, deploymentChainId] = await Promise.all([
  read('COVER_URL'), read('COVER_SHA256'), read('name'),
  read('nextTokenId'), read('deploymentChainId'),
]);
assert.equal(deploymentChainId, 56n);
assert.equal(name, 'Fly Cartridge V3');
const sha = (data) => `0x${createHash('sha256').update(data).digest('hex')}`;
const local = fs.readFileSync(path.join(root,
  'public/nft/fly-cartridge-v3-0ec7c8477b27.png'));
assert.equal(sha(local), coverHash);
const response = await fetch(coverUrl, { signal: AbortSignal.timeout(15_000) });
assert.equal(response.status, 200);
assert.ok(response.headers.get('content-type')?.includes('image/png'));
const hosted = Buffer.from(await response.arrayBuffer());
assert.equal(sha(hosted), coverHash);
assert.deepEqual(hosted, local);
const result = { address, chainId, bytecodeMatches: true, name, coverUrl,
  coverSha256: coverHash, imageAvailable: true,
  imageBytes: hosted.length, minted: Number(nextTokenId - 1n) };
if (nextTokenId > 1n) {
  const tokenId = 1n;
  const uri = await read('tokenURI', [tokenId]);
  const prefix = 'data:application/json;base64,';
  assert.ok(uri.startsWith(prefix));
  const metadata = JSON.parse(Buffer.from(uri.slice(prefix.length), 'base64').toString('utf8'));
  assert.equal(metadata.image, coverUrl);
  assert.ok(metadata.attributes?.some((item) =>
    item.trait_type === 'coverSha256' && item.value.toLowerCase() === coverHash));
  result.firstToken = { tokenId: tokenId.toString(), owner: await read('ownerOf', [tokenId]),
    cardId: await read('cardIdByToken', [tokenId]), image: metadata.image,
    metadataImageMatches: true };
  const card = await read('card', [result.firstToken.cardId]);
  assert.equal(card.tokenId, tokenId);
  const published = await client.getBlock({ blockNumber: card.publishBlock,
    includeTransactions: true });
  const matches = published.transactions.filter((tx) => {
    if (typeof tx === 'string' || tx.to?.toLowerCase() !== address.toLowerCase()) return false;
    try {
      const call = decodeFunctionData({ abi: artifact.abi, data: tx.input });
      return call.functionName === 'publish' &&
        sha(Buffer.from(call.args[0].slice(2), 'hex')) === result.firstToken.cardId;
    } catch { return false; }
  });
  assert.equal(matches.length, 1, 'Expected one matching publish in the NFT block');
  const call = decodeFunctionData({ abi: artifact.abi, data: matches[0].input });
  const receipt = await client.getTransactionReceipt({ hash: matches[0].hash });
  assert.equal(receipt.status, 'success');
  assert.equal(sha(Buffer.from(call.args[1].slice(2), 'hex')), card.stateSha256);
  assert.equal(call.args[2].toLowerCase(), card.stateKey);
  result.firstToken.publishTx = matches[0].hash;
  result.firstToken.publishGas = receipt.gasUsed.toString();
  result.firstToken.publishBlock = card.publishBlock.toString();
}
console.log(JSON.stringify(result));
