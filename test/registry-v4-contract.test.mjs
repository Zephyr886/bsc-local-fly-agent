import assert from 'node:assert/strict';
import crypto, { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { encodeFunctionData } from 'viem';

import {
  computeContentKey,
  findPublishedCall,
  parseManifestCommitments,
  V4_CHAIN_LIMITS,
} from '../scripts/fly_cartridge_v4_chain_read.mjs';

const artifact = JSON.parse(readFileSync(new URL(
  '../artifacts/fly-cartridge-v4-registry-candidate.json', import.meta.url)));
const vectors = JSON.parse(readFileSync(new URL(
  './fixtures/registry-v4-vectors.json', import.meta.url)));
const source = readFileSync(new URL('../contracts/FlyCartridgeRegistryV4.sol', import.meta.url), 'utf8');
const deploySource = readFileSync(new URL(
  '../scripts/deploy-fly-cartridge-v4-registry.mjs', import.meta.url), 'utf8');
const publishSource = readFileSync(new URL(
  '../scripts/publish-fly-cartridge-v4-testnet.mjs', import.meta.url), 'utf8');
const hex = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const ZERO_BYTES32 = `0x${'00'.repeat(32)}`;

test('Registry V4 tracked artifact exposes the frozen immutable interface', () => {
  assert.equal(artifact.contractName, 'FlyCartridgeRegistryV4');
  assert.equal(artifact.compilerVersion, '0.8.37+commit.f401782d.Emscripten.clang');
  assert.equal(artifact.evmVersion, 'cancun');
  assert.ok((artifact.deployedBytecode.length - 2) / 2 < 24_576);
  const functions = artifact.abi.filter((entry) => entry.type === 'function')
    .map((entry) => entry.name);
  for (const name of ['publish', 'card', 'contentKey', 'tokenByCardId',
    'tokenByContentKey', 'cardIdByToken', 'deploymentChainId', 'tokenURI']) {
    assert.ok(functions.includes(name), `ABI missing ${name}`);
  }
  assert.match(source, /mapping\(bytes32 => uint256\) public tokenByContentKey/);
  assert.match(source, /parentRegistry == address\(this\)/);
  assert.doesNotMatch(source, /delegatecall|selfdestruct|function\s+upgrade|Ownable/);
});

test('Registry V4 deployment and publication fail closed around chain and secrets', () => {
  assert.match(deploySource, /--confirm-testnet/);
  assert.match(deploySource, /--confirm-mainnet/);
  assert.match(deploySource, /DEPLOY_IMMUTABLE_V4_MAINNET/);
  assert.match(deploySource, /expectedRuntimeCode\(chain\.id\)/);
  assert.match(publishSource, /--confirm-testnet/);
  assert.match(publishSource, /expectedRuntimeCode\(97\)/);
  assert.match(publishSource, /recoverV4/);
  assert.match(publishSource, /freshInstallVerified: true/);
  assert.doesNotMatch(`${deploySource}\n${publishSource}`, /console\.log\([^)]*privateKey/);
});

test('Registry V4 commitment vector is stable', () => {
  const vector = vectors.vectors[0];
  const manifest = Buffer.from(vector.manifestHex, 'hex');
  const state = Buffer.from(vector.stateHex, 'hex');
  assert.equal(digest(manifest), vector.cardId);
  assert.equal(digest(state), vector.stateSha256);
  assert.equal(computeContentKey(`0x${vector.profileHash}`, `0x${vector.stateSha256}`),
    `0x${vector.contentKey}`);
});

test('contentKey deterministically binds both Profile and state across randomized vectors', () => {
  const seen = new Set();
  for (let index = 0; index < 256; index += 1) {
    const profileHash = hex(randomBytes(32));
    const stateSha256 = hex(randomBytes(32));
    const key = computeContentKey(profileHash, stateSha256);
    assert.equal(key, computeContentKey(profileHash, stateSha256));
    assert.notEqual(key, computeContentKey(hex(randomBytes(32)), stateSha256));
    assert.notEqual(key, computeContentKey(profileHash, hex(randomBytes(32))));
    assert.equal(seen.has(key), false);
    seen.add(key);
  }
});

test('V4 manifest commitments and chain publication limits agree', () => {
  const state = Buffer.from('learned-state');
  const profileHash = '11'.repeat(32);
  const stateKey = '22'.repeat(32);
  const manifest = Buffer.from(`${JSON.stringify({
    format: 'fly-cartridge', formatVersion: 4,
    fly: { profileHash: `sha256:${profileHash}`, profileSchemaVersion: 1, profileRevision: 9 },
    traitKey: `sha256:${stateKey}`,
    state: { bytes: state.length, sha256: digest(state) },
    lineage: { parentRegistry: null, parentCardId: null },
  })}\n`);
  const result = parseManifestCommitments(manifest, state);
  assert.equal(result.cardId, `0x${digest(manifest)}`);
  assert.equal(result.profileHash, `0x${profileHash}`);
  assert.equal(result.stateKey, `0x${stateKey}`);
  assert.equal(result.parentRegistry, ZERO_ADDRESS);
  assert.equal(result.parentCardId, ZERO_BYTES32);
  assert.equal(V4_CHAIN_LIMITS.maxManifestBytes, 32_768);
  assert.equal(V4_CHAIN_LIMITS.maxPublicationBytes, 120_000);
  assert.throws(() => parseManifestCommitments(Buffer.alloc(32_769), state), /size/);
});

test('V4 recovery selects exactly one successful publish transaction', async () => {
  const address = `0x${'33'.repeat(20)}`;
  const creator = `0x${'44'.repeat(20)}`;
  const manifest = Buffer.from('registry-v4-publish');
  const cardId = `0x${digest(manifest)}`;
  const args = [hex(manifest), '0x0102', `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`,
    ZERO_ADDRESS, ZERO_BYTES32, 1, 1];
  const tx = {
    to: address, from: creator, hash: `0x${'55'.repeat(32)}`,
    input: encodeFunctionData({ abi: artifact.abi, functionName: 'publish', args }),
  };
  const client = { getTransactionReceipt: async () => ({ status: 'success' }) };
  assert.deepEqual(await findPublishedCall(client,
    { number: 7n, transactions: [tx] }, address, creator, cardId), args);
  await assert.rejects(findPublishedCall(client,
    { number: 7n, transactions: [tx, tx] }, address, creator, cardId), /found 2/);
  const failed = { getTransactionReceipt: async () => ({ status: 'reverted' }) };
  await assert.rejects(findPublishedCall(failed,
    { number: 7n, transactions: [tx] }, address, creator, cardId), /found 0/);
  await assert.rejects(findPublishedCall(client,
    { number: 7n, transactions: [tx.hash] }, address, creator, cardId), /historical transaction bodies/);
});
