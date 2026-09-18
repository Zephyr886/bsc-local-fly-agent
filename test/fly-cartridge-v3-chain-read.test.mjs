import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { encodeFunctionData } from 'viem';
import { findCall } from '../scripts/fly_cartridge_v3_chain_read.mjs';

const abi = JSON.parse(readFileSync(new URL('../artifacts/fly-cartridge-v3-auto.json', import.meta.url))).abi;
const address = '0x1111111111111111111111111111111111111111';
const formerRelay = '0x2222222222222222222222222222222222222222';
const currentRelay = '0x3333333333333333333333333333333333333333';
const cardId = `0x${'ab'.repeat(32)}`;
const tx = {
  to: address,
  from: formerRelay,
  hash: `0x${'cd'.repeat(32)}`,
  input: encodeFunctionData({ abi, functionName: 'upload', args: [cardId, 0, '0x0102'] }),
};

test('reads a confirmed chunk uploaded before the relay changed', async () => {
  const client = { getTransactionReceipt: async () => ({ status: 'success' }) };
  const args = await findCall(client, { number: 10n, transactions: [tx] },
    address, null, abi, 'upload', (call) => call[0] === cardId && call[1] === 0);
  assert.equal(args[2], '0x0102');
  await assert.rejects(findCall(client, { number: 10n, transactions: [tx] },
    address, currentRelay, abi, 'upload', () => true), /found 0/);
});

test('does not recover an upload from a failed transaction', async () => {
  const client = { getTransactionReceipt: async () => ({ status: 'reverted' }) };
  await assert.rejects(findCall(client, { number: 10n, transactions: [tx] },
    address, null, abi, 'upload', () => true), /found 0/);
});
