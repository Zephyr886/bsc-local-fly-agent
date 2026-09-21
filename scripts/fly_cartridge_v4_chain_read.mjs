// Read-only recovery of a Registry V4 cartridge from immutable publish calldata.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, decodeFunctionData, http, isAddress } from 'viem';

const artifact = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,
  '../artifacts/fly-cartridge-v4-registry-candidate.json')));
const TESTNET_GENESIS = '0x6d3c66c5357ec91d5c43af47e234a939b22557cbb552dc45bebbceeed90fbe34';
const MAINNET_GENESIS = '0x0d21840abff46b96c84b2ac9e10e4f5cdaeb5693cb665db62a2f3b02d2d57b5b';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 = `0x${'00'.repeat(32)}`;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const MANIFEST_HASH = /^sha256:([0-9a-f]{64})$/;
export const V4_CHAIN_LIMITS = Object.freeze({ maxManifestBytes: 32_768,
  maxPublicationBytes: 120_000 });

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
export const sha256 = (bytes) => `0x${crypto.createHash('sha256').update(bytes).digest('hex')}`;

export function computeContentKey(profileHash, stateSha256) {
  if (!HASH.test(profileHash) || !HASH.test(stateSha256)) throw new Error('Invalid content key input');
  return sha256(Buffer.concat([
    Buffer.from(profileHash.slice(2), 'hex'), Buffer.from(stateSha256.slice(2), 'hex'),
  ]));
}

export function expectedRuntimeCode(chainId, selectedArtifact = artifact) {
  let code = selectedArtifact.deployedBytecode.slice(2).toLowerCase();
  const chain = BigInt(chainId).toString(16).padStart(64, '0');
  for (const refs of Object.values(selectedArtifact.immutableReferences)) {
    for (const ref of refs) {
      if (ref.length !== 32) throw new Error('Unknown immutable layout');
      const at = ref.start * 2;
      code = code.slice(0, at) + chain + code.slice(at + 64);
    }
  }
  return `0x${code}`;
}

export function parseManifestCommitments(manifest, state) {
  if (!Buffer.isBuffer(manifest) || !Buffer.isBuffer(state) || !manifest.length || !state.length ||
      manifest.length > V4_CHAIN_LIMITS.maxManifestBytes ||
      manifest.length + state.length > V4_CHAIN_LIMITS.maxPublicationBytes) {
    throw new Error('Registry V4 publication size is invalid');
  }
  let parsed;
  try { parsed = JSON.parse(manifest.toString('utf8')); }
  catch { throw new Error('Invalid v4 manifest JSON'); }
  const profileMatch = MANIFEST_HASH.exec(parsed?.fly?.profileHash || '');
  const traitMatch = MANIFEST_HASH.exec(parsed?.traitKey || '');
  if (parsed?.format !== 'fly-cartridge' || parsed?.formatVersion !== 4 ||
      !profileMatch || !traitMatch || parsed.fly.profileSchemaVersion !== 1 ||
      !Number.isInteger(parsed.fly.profileRevision) || parsed.fly.profileRevision < 1 ||
      parsed.fly.profileRevision > 999_999 ||
      parsed.state?.bytes !== state.length || !/^[0-9a-f]{64}$/.test(parsed.state?.sha256 || '')) {
    throw new Error('Registry V4 manifest identity is invalid');
  }
  const stateSha256 = sha256(state);
  if (!same(`0x${parsed.state.sha256}`, stateSha256)) {
    throw new Error('Registry V4 state commitment mismatch');
  }
  const parentRegistry = parsed.lineage?.parentRegistry ?? ZERO_ADDRESS;
  const parentCardId = parsed.lineage?.parentCardId ?? ZERO_BYTES32;
  const parentEmpty = same(parentRegistry, ZERO_ADDRESS) && same(parentCardId, ZERO_BYTES32);
  const parentSet = isAddress(parentRegistry) && !same(parentRegistry, ZERO_ADDRESS) &&
    HASH.test(parentCardId) && !same(parentCardId, ZERO_BYTES32);
  if (!parentEmpty && !parentSet) throw new Error('Registry V4 lineage is invalid');
  const profileHash = `0x${profileMatch[1]}`;
  return {
    parsed,
    cardId: sha256(manifest),
    profileHash,
    stateKey: `0x${traitMatch[1]}`,
    stateSha256,
    contentKey: computeContentKey(profileHash, stateSha256),
    parentRegistry,
    parentCardId,
    profileSchemaVersion: parsed.fly.profileSchemaVersion,
    profileRevision: parsed.fly.profileRevision,
  };
}

export async function findPublishedCall(client, block, address, creator, cardId,
                                        selectedArtifact = artifact) {
  if (block.transactions.some((tx) => typeof tx === 'string')) {
    throw new Error('RPC did not return historical transaction bodies');
  }
  const matches = [];
  for (const tx of block.transactions) {
    if (!tx.to || !same(tx.to, address) || !same(tx.from, creator)) continue;
    try {
      const call = decodeFunctionData({ abi: selectedArtifact.abi, data: tx.input });
      if (call.functionName !== 'publish' ||
          !same(sha256(Buffer.from(call.args[0].slice(2), 'hex')), cardId)) continue;
      const receipt = await client.getTransactionReceipt({ hash: tx.hash });
      if (receipt.status === 'success') matches.push(call.args);
    } catch { /* Unrelated calls cannot supply this card. */ }
  }
  if (matches.length !== 1) {
    throw new Error(`Expected one successful V4 publish call in block ${block.number}, found ${matches.length}`);
  }
  return matches[0];
}

export async function recoverV4({ rpc, address, cardId, chainId = 97, client: suppliedClient }) {
  if ((!rpc && !suppliedClient) || !isAddress(address) || !HASH.test(cardId)) {
    throw new Error('Invalid Registry V4 recovery arguments');
  }
  if (rpc) {
    const url = new URL(rpc);
    if (chainId !== 97 && chainId !== 56 && !(chainId === 31337 &&
        ['127.0.0.1', 'localhost'].includes(url.hostname))) {
      throw new Error('Unsupported Registry V4 recovery chain');
    }
  }
  const client = suppliedClient ?? createPublicClient({ transport: http(rpc) });
  const actualChainId = await client.getChainId();
  if (actualChainId !== chainId) throw new Error(`Wrong chain: ${actualChainId}`);
  if (chainId === 97 && !same((await client.getBlock({ blockNumber: 0n })).hash,
      TESTNET_GENESIS)) throw new Error('Wrong BSC testnet genesis');
  if (chainId === 56 && !same((await client.getBlock({ blockNumber: 0n })).hash,
      MAINNET_GENESIS)) throw new Error('Wrong BSC mainnet genesis');

  const [contractChainId, code, card] = await Promise.all([
    client.readContract({ address, abi: artifact.abi, functionName: 'deploymentChainId' }),
    client.getBytecode({ address }),
    client.readContract({ address, abi: artifact.abi, functionName: 'card', args: [cardId] }),
  ]);
  if (contractChainId !== BigInt(chainId) || !code ||
      !same(code, expectedRuntimeCode(chainId))) throw new Error('Registry V4 code or chain mismatch');
  if (!card.creator || same(card.creator, ZERO_ADDRESS) || card.tokenId === 0n ||
      card.publishBlock === 0n || Number(card.manifestLength) < 1 ||
      Number(card.manifestLength) > V4_CHAIN_LIMITS.maxManifestBytes ||
      Number(card.stateLength) < 1 ||
      Number(card.manifestLength) + Number(card.stateLength) > V4_CHAIN_LIMITS.maxPublicationBytes) {
    throw new Error('Registry V4 card is absent or invalid');
  }
  const contentKey = computeContentKey(card.profileHash, card.stateSha256);
  const [tokenId, contentToken, linkedCardId, owner] = await Promise.all([
    client.readContract({ address, abi: artifact.abi, functionName: 'tokenByCardId', args: [cardId] }),
    client.readContract({ address, abi: artifact.abi, functionName: 'tokenByContentKey', args: [contentKey] }),
    client.readContract({ address, abi: artifact.abi, functionName: 'cardIdByToken', args: [card.tokenId] }),
    client.readContract({ address, abi: artifact.abi, functionName: 'ownerOf', args: [card.tokenId] }),
  ]);
  if (tokenId !== card.tokenId || contentToken !== card.tokenId || !same(linkedCardId, cardId)) {
    throw new Error('Registry V4 NFT commitment link mismatch');
  }
  const block = await client.getBlock({ blockNumber: card.publishBlock, includeTransactions: true });
  const args = await findPublishedCall(client, block, address, card.creator, cardId);
  const manifest = Buffer.from(args[0].slice(2), 'hex');
  const state = Buffer.from(args[1].slice(2), 'hex');
  const commitments = parseManifestCommitments(manifest, state);
  const expectedArgs = [commitments.profileHash, commitments.stateKey,
    commitments.parentRegistry, commitments.parentCardId];
  const actualArgs = [args[2], args[3], args[4], args[5]];
  if (manifest.length !== Number(card.manifestLength) || state.length !== Number(card.stateLength) ||
      !same(commitments.cardId, cardId) || !same(commitments.stateSha256, card.stateSha256) ||
      !same(commitments.contentKey, contentKey) ||
      expectedArgs.some((value, index) => !same(value, actualArgs[index])) ||
      BigInt(args[6]) !== BigInt(card.profileSchemaVersion) ||
      BigInt(args[7]) !== BigInt(card.profileRevision) ||
      commitments.profileSchemaVersion !== Number(card.profileSchemaVersion) ||
      commitments.profileRevision !== Number(card.profileRevision)) {
    throw new Error('Registry V4 publish calldata does not match chain commitments');
  }
  return { manifest, state, summary: {
    chainId, address, cardId, tokenId: card.tokenId.toString(), creator: card.creator, owner,
    profileHash: card.profileHash, stateKey: card.stateKey, stateSha256: card.stateSha256,
    contentKey, parentRegistry: card.parentRegistry, parentCardId: card.parentCardId,
    profileSchemaVersion: Number(card.profileSchemaVersion),
    profileRevision: Number(card.profileRevision), manifestBytes: manifest.length,
    stateBytes: state.length, publishBlock: card.publishBlock.toString(),
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const arg = (name) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  try {
    const network = arg('--chain') ?? 'testnet';
    if (!['testnet', 'mainnet'].includes(network)) throw new Error('Use --chain testnet or mainnet');
    const chainId = network === 'mainnet' ? 56 : 97;
    const defaultRpc = network === 'mainnet' ? 'https://bsc-dataseed.bnbchain.org' :
      'https://bsc-testnet-dataseed.bnbchain.org';
    const result = await recoverV4({ rpc: arg('--rpc') ?? defaultRpc,
      address: arg('--address'), cardId: arg('--card-id'), chainId });
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
