import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { REGISTRY_V4_CONFIRMATION_PHRASES,
  REGISTRY_V4_NETWORKS } from '../src/chain/registry-v4-console.mjs';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const html = read('../public/registry-v4.html');
const browser = read('../public/registry-v4.js');
const service = read('../src/chain/registry-v4-console.mjs');
const server = read('../src/server.mjs');
const vault = read('../src/wallet/local-vault.mjs');

test('Registry V4 console is a local fixed-operation UI, not an arbitrary signer', () => {
  assert.match(html, /Registry V4 部署与上链闭环/);
  assert.match(html, /部署合约并发布上次导出的 v4 卡带/);
  assert.match(html, /部署及发布不可回滚/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)/);
  for (const id of ['registry-network', 'registry-mode', 'registry-password',
    'registry-phrase']) assert.match(html, new RegExp(`<label[^>]+for="${id}"`));
  assert.match(browser, /\/api\/registry-v4\/prepare/);
  assert.match(browser, /\/api\/registry-v4\/execute/);
  assert.doesNotMatch(browser, /localStorage|sessionStorage|privateKey|mnemonic/);
  assert.doesNotMatch(html, /name="(?:to|data|bytecode)"/);
});

test('Registry V4 server freezes chain, bytecode, ABI, gas and confirmation boundaries', () => {
  assert.deepEqual(Object.keys(REGISTRY_V4_NETWORKS), ['mainnet', 'testnet']);
  assert.equal(REGISTRY_V4_NETWORKS.mainnet.chainId, 56);
  assert.equal(REGISTRY_V4_NETWORKS.testnet.chainId, 97);
  assert.ok(Object.isFrozen(REGISTRY_V4_NETWORKS));
  assert.equal(REGISTRY_V4_CONFIRMATION_PHRASES.mainnet, '确认主网部署并发布卡带');
  assert.match(service, /\['deploy', 'deploy-and-publish', 'publish'\]\.includes\(mode\)/);
  assert.match(service, /expectedRuntimeCode\(network\.chainId\)/);
  assert.match(service, /PUBLICATION_GAS_BUDGET/);
  assert.match(service, /预览后导出卡带已变化/);
  assert.match(service, /回读字节与本地导出不一致/);
  assert.match(service, /freshInstall/);
  assert.match(server, /readSecretJson\(request,[\s\S]*authorizationId[\s\S]*confirmationPhrase/);
  assert.match(vault, /function walletNetwork\(network\)/);
  assert.doesNotMatch(service, /request\.(?:to|data|bytecode)/);
});

test('Registry V4 console assets and API are wired into the loopback server', () => {
  for (const route of ['/registry-v4', '/registry-v4.html', '/registry-v4.js',
    '/api/registry-v4/status', '/api/registry-v4/prepare', '/api/registry-v4/execute']) {
    assert.ok(server.includes(route), route);
  }
  assert.match(server, /url\.pathname\.startsWith\("\/api\/registry-v4\/"\)\) localDeckRequest/);
});
