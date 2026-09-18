// Read-only FlyCartridge v3 testnet recovery. No website, wallet or private key.
// Requires an RPC that returns historical full block transactions.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, decodeFunctionData, http, isAddress, keccak256,
  concatHex, toBytes } from 'viem';

const artifact = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,
  '../artifacts/fly-cartridge-v3-auto.json')));
const sha256 = (bytes) => `0x${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const CHAIN_ID = 97;
const GENESIS = '0x6d3c66c5357ec91d5c43af47e234a939b22557cbb552dc45bebbceeed90fbe34';
const MAX_STATE = 262_144;
const MAX_MANIFEST = 16_384;
const MAX_CHUNK = 24_576;
const CHUNK_DOMAIN = 'FlyCartridge/v3/chunks';

function expectedRuntimeCode() {
  let code = artifact.deployedBytecode.slice(2).toLowerCase();
  const chain = BigInt(CHAIN_ID).toString(16).padStart(64, '0');
  for (const refs of Object.values(artifact.immutableReferences)) {
    for (const ref of refs) {
      if (ref.length !== 32) throw new Error('Unknown immutable layout');
      const at = ref.start * 2;
      code = code.slice(0, at) + chain + code.slice(at + 64);
    }
  }
  return `0x${code}`;
}

export async function findCall(client, block, address, sender, abi, functionName, predicate) {
  if (block.transactions.some((tx) => typeof tx === 'string')) {
    throw new Error('RPC did not return historical transaction bodies');
  }
  const matches = [];
  for (const tx of block.transactions) {
    if (!tx.to || !same(tx.to, address) || (sender && !same(tx.from, sender))) continue;
    try {
      const call = decodeFunctionData({ abi, data: tx.input });
      if (call.functionName === functionName && predicate(call.args)) {
        const receipt = await client.getTransactionReceipt({ hash: tx.hash });
        if (receipt.status === 'success') matches.push(call.args);
      }
    } catch { /* Other calls to the same contract are irrelevant. */ }
  }
  if (matches.length !== 1) throw new Error(`Expected one ${functionName} call in block ${block.number}, found ${matches.length}`);
  return matches[0];
}

export async function recover({ rpc, address, cardId }) {
  if (!rpc || !isAddress(address) || !/^0x[0-9a-fA-F]{64}$/.test(cardId)) {
    throw new Error('Invalid recovery arguments');
  }
  const client = createPublicClient({ transport: http(rpc) });
  const actualChainId = await client.getChainId();
  if (actualChainId !== CHAIN_ID ||
      !same((await client.getBlock({ blockNumber: 0n })).hash, GENESIS)) {
    throw new Error(`Wrong BSC testnet: ${actualChainId}`);
  }
  const contractChainId = await client.readContract({ address, abi: artifact.abi,
    functionName: 'deploymentChainId' });
  const code = await client.getBytecode({ address });
  if (contractChainId !== BigInt(CHAIN_ID) || !code ||
      !same(code, expectedRuntimeCode())) {
    throw new Error('Contract code or chain ID mismatch');
  }
  const card = await client.readContract({ address, abi: artifact.abi,
    functionName: 'card', args: [cardId] });
  if (!card.finalized || !card.creator || same(card.creator, '0x0000000000000000000000000000000000000000')) {
    throw new Error('Card is absent or unfinished');
  }
  if (Number(card.stateLength) < 1 || Number(card.stateLength) > MAX_STATE ||
      Number(card.manifestLength) < 1 || Number(card.manifestLength) > MAX_MANIFEST ||
      Number(card.chunkCount) !== Math.ceil(Number(card.stateLength) / MAX_CHUNK) ||
      Number(card.received) !== Number(card.chunkCount) ||
      Number(card.uploadedBytes) !== Number(card.stateLength)) {
    throw new Error('Invalid chain card metadata');
  }
  const tokenId = await client.readContract({ address, abi: artifact.abi,
    functionName: 'tokenByCardId', args: [cardId] });
  if (tokenId === 0n) throw new Error('Finalized card has no NFT');
  const owner = await client.readContract({ address, abi: artifact.abi,
    functionName: 'ownerOf', args: [tokenId] });
  const beginBlock = await client.getBlock({ blockNumber: card.manifestBlock, includeTransactions: true });
  const begin = await findCall(client, beginBlock, address, card.creator, artifact.abi, 'begin', (args) =>
    same(sha256(Buffer.from(args[0].slice(2), 'hex')), cardId));
  const manifest = Buffer.from(begin[0].slice(2), 'hex');
  if (manifest.length !== Number(card.manifestLength) || !same(sha256(manifest), cardId) ||
      !same(begin[1], card.stateKey) || !same(begin[2], card.parentCardId) ||
      !same(begin[3], card.stateSha256) || Number(begin[4]) !== Number(card.stateLength) ||
      !same(begin[5], card.chunksCommitment)) throw new Error('Manifest transaction mismatch');

  const parts = [];
  let rolling = keccak256(toBytes(CHUNK_DOMAIN));
  for (let index = 0; index < Number(card.chunkCount); index++) {
    const entry = await client.readContract({ address, abi: artifact.abi,
      functionName: 'chunk', args: [cardId, index] });
    const expectedLength = index === Number(card.chunkCount) - 1
      ? Number(card.stateLength) - index * MAX_CHUNK : MAX_CHUNK;
    if (Number(entry.length) !== expectedLength || entry.blockNumber === 0n) {
      throw new Error(`Invalid chunk ${index} metadata`);
    }
    const block = await client.getBlock({ blockNumber: entry.blockNumber, includeTransactions: true });
    // changeRelay can replace the signer after earlier chunks were confirmed.
    // The successful call and the on-chain chunk digest identify each upload;
    // the card's current relay cannot identify historical upload signers.
    const args = await findCall(client, block, address, null,
      artifact.abi, 'upload', (call) =>
      same(call[0], cardId) && Number(call[1]) === index);
    const bytes = Buffer.from(args[2].slice(2), 'hex');
    if (bytes.length !== expectedLength || !same(sha256(bytes), entry.sha256Digest)) {
      throw new Error(`Chunk ${index} checksum mismatch`);
    }
    rolling = keccak256(concatHex([rolling, entry.sha256Digest]));
    parts.push(bytes);
  }
  const state = Buffer.concat(parts);
  if (state.length !== Number(card.stateLength) || !same(sha256(state), card.stateSha256) ||
      !same(rolling, card.chunksCommitment)) throw new Error('Final state commitment mismatch');
  let parsed;
  try { parsed = JSON.parse(manifest.toString('utf8')); }
  catch { throw new Error('Invalid v3 manifest JSON'); }
  if (parsed.format !== 'fly-cartridge' || parsed.formatVersion !== 3 ||
      parsed.state?.bytes !== state.length || !same(`0x${parsed.state?.sha256}`, sha256(state)) ||
      !same(`0x${parsed.traitKey}`, card.stateKey)) {
    throw new Error('V3 manifest identity mismatch; run Python verify for full neural validation');
  }
  return { manifest, state, summary: { chainId: CHAIN_ID, address, cardId, tokenId: tokenId.toString(),
    creator: card.creator, owner, parentCardId: card.parentCardId,
    stateKey: card.stateKey, manifestBytes: manifest.length, stateBytes: state.length,
    chunkCount: parts.length, stateSha256: sha256(state), chunksCommitment: rolling } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const arg = (name) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  try {
    const result = await recover({ rpc: arg('--rpc') ?? 'https://bsc-testnet-dataseed.bnbchain.org',
      address: arg('--address'), cardId: arg('--card-id') });
    const out = arg('--out');
    if (out) {
      fs.mkdirSync(out);
      fs.writeFileSync(path.join(out, 'cartridge.json'), result.manifest, { flag: 'wx' });
      fs.writeFileSync(path.join(out, 'state.bin'), result.state, { flag: 'wx' });
    }
    console.log(JSON.stringify(result.summary, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
