import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import crypto from 'node:crypto';
import { encodeFunctionData } from 'viem';
import { findPublishedCall } from '../scripts/fly_cartridge_v3_direct_chain_read.mjs';

const abi = JSON.parse(readFileSync(new URL(
  '../artifacts/fly-cartridge-v3-direct-candidate.json', import.meta.url))).abi;
const address = '0x1111111111111111111111111111111111111111';
const creator = '0x2222222222222222222222222222222222222222';
const manifest = Buffer.from('{"format":"fly-cartridge"}');
const cardId = `0x${crypto.createHash('sha256').update(manifest).digest('hex')}`;
const state = '0x010203';
const tx = {
  to: address, from: creator, hash: `0x${'ab'.repeat(32)}`,
  input: encodeFunctionData({ abi, functionName: 'publish',
    args: [`0x${manifest.toString('hex')}`, state, `0x${'cd'.repeat(32)}`,
      `0x${'00'.repeat(32)}`] }),
};

test('recovers exactly one successful wallet-direct publish call', async () => {
  const client = { getTransactionReceipt: async () => ({ status: 'success' }) };
  const args = await findPublishedCall(client,
    { number: 5n, transactions: [tx] }, address, creator, cardId);
  assert.equal(args[1], state);
  await assert.rejects(findPublishedCall(client,
    { number: 5n, transactions: [tx, tx] }, address, creator, cardId),
  /found 2/);
});

test('rejects failed publish and RPC responses without transaction bodies', async () => {
  const client = { getTransactionReceipt: async () => ({ status: 'reverted' }) };
  await assert.rejects(findPublishedCall(client,
    { number: 5n, transactions: [tx] }, address, creator, cardId),
  /found 0/);
  await assert.rejects(findPublishedCall(client,
    { number: 5n, transactions: [tx.hash] }, address, creator, cardId),
  /historical transaction bodies/);
});
