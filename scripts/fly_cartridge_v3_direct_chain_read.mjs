// Read-only recovery of a wallet-direct v3 cartridge from publish calldata.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, decodeFunctionData, http, isAddress } from 'viem';

const artifact = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,
  '../artifacts/fly-cartridge-v3-direct-candidate.json')));
const imageArtifact = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,
  '../artifacts/fly-cartridge-v3-image-candidate.json')));
const sha256 = (bytes) => `0x${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const TESTNET_GENESIS = '0x6d3c66c5357ec91d5c43af47e234a939b22557cbb552dc45bebbceeed90fbe34';
const MAINNET_GENESIS = '0x0d21840abff46b96c84b2ac9e10e4f5cdaeb5693cb665db62a2f3b02d2d57b5b';
const MAX_PUBLICATION = 120_000;
const MAX_MANIFEST = 16_384;

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
    } catch { /* Other calls cannot supply this card. */ }
  }
  if (matches.length !== 1) {
    throw new Error(`Expected one successful publish call in block ${block.number}, found ${matches.length}`);
  }
  return matches[0];
}

export async function recover({ rpc, address, cardId, chainId = 97, image = false }) {
  if (!rpc || !isAddress(address) || !/^0x[0-9a-fA-F]{64}$/.test(cardId)) {
    throw new Error('Invalid recovery arguments');
  }
  const url = new URL(rpc);
  if (chainId !== 97 && chainId !== 56 && !(chainId === 31337 &&
      ['127.0.0.1', 'localhost'].includes(url.hostname))) {
    throw new Error('Unsupported recovery chain');
  }
  const client = createPublicClient({ transport: http(rpc) });
  const selectedArtifact = image ? imageArtifact : artifact;
  const actualChainId = await client.getChainId();
  if (actualChainId !== chainId) throw new Error(`Wrong chain: ${actualChainId}`);
  if (chainId === 97 && !same((await client.getBlock({ blockNumber: 0n })).hash,
      TESTNET_GENESIS)) throw new Error('Wrong BSC testnet genesis');
  if (chainId === 56 && !same((await client.getBlock({ blockNumber: 0n })).hash,
      MAINNET_GENESIS)) throw new Error('Wrong BSC mainnet genesis');
  const contractChainId = await client.readContract({ address, abi: selectedArtifact.abi,
    functionName: 'deploymentChainId' });
  const code = await client.getBytecode({ address });
  if (contractChainId !== BigInt(chainId) || !code ||
      !same(code, expectedRuntimeCode(chainId, selectedArtifact))) {
    throw new Error('Contract code or chain ID mismatch');
  }
  const card = await client.readContract({ address, abi: selectedArtifact.abi,
    functionName: 'card', args: [cardId] });
  if (!card.creator || same(card.creator, '0x0000000000000000000000000000000000000000') ||
      card.tokenId === 0n || card.publishBlock === 0n ||
      Number(card.manifestLength) < 1 || Number(card.manifestLength) > MAX_MANIFEST ||
      Number(card.stateLength) < 1 ||
      Number(card.manifestLength) + Number(card.stateLength) > MAX_PUBLICATION) {
    throw new Error('Card is absent or invalid');
  }
  const tokenId = await client.readContract({ address, abi: selectedArtifact.abi,
    functionName: 'tokenByCardId', args: [cardId] });
  if (tokenId !== card.tokenId || (await client.readContract({
      address, abi: selectedArtifact.abi, functionName: 'cardIdByToken', args: [tokenId],
    })).toLowerCase() !== cardId.toLowerCase()) throw new Error('NFT card link mismatch');
  const owner = await client.readContract({ address, abi: selectedArtifact.abi,
    functionName: 'ownerOf', args: [tokenId] });
  const block = await client.getBlock({
    blockNumber: card.publishBlock, includeTransactions: true,
  });
  const args = await findPublishedCall(client, block, address, card.creator, cardId,
    selectedArtifact);
  const manifest = Buffer.from(args[0].slice(2), 'hex');
  const state = Buffer.from(args[1].slice(2), 'hex');
  if (manifest.length !== Number(card.manifestLength) ||
      state.length !== Number(card.stateLength) ||
      !same(sha256(manifest), cardId) ||
      !same(sha256(state), card.stateSha256) ||
      !same(args[2], card.stateKey) || !same(args[3], card.parentCardId)) {
    throw new Error('Publish transaction does not match chain commitments');
  }
  let parsed;
  try { parsed = JSON.parse(manifest.toString('utf8')); }
  catch { throw new Error('Invalid v3 manifest JSON'); }
  if (parsed.format !== 'fly-cartridge' || parsed.formatVersion !== 3 ||
      parsed.state?.bytes !== state.length ||
      !same(`0x${parsed.state?.sha256}`, sha256(state)) ||
      !same(`0x${parsed.traitKey}`, card.stateKey)) {
    throw new Error('V3 manifest identity mismatch; run Python verify for full neural validation');
  }
  return { manifest, state, summary: {
    chainId, address, cardId, tokenId: tokenId.toString(),
    creator: card.creator, owner, parentCardId: card.parentCardId,
    stateKey: card.stateKey, manifestBytes: manifest.length,
    stateBytes: state.length, stateSha256: sha256(state),
    publishBlock: card.publishBlock.toString(),
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
    const result = await recover({ rpc: arg('--rpc') ?? defaultRpc,
      address: arg('--address'), cardId: arg('--card-id'), chainId,
      image: process.argv.includes('--image') });
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
