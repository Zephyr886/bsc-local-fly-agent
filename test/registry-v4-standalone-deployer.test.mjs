import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const template = read('../tools/registry-v4-deployer/template.html');
const source = read('../tools/registry-v4-deployer/app.mjs');
const builder = read('../scripts/build-registry-v4-deployer.mjs');
const output = read('../deployment/registry-v4/FLAP-Registry-V4-Deployer.html');
const server = read('../src/server.mjs');
const cartridge = read('../public/cartridge.html');
const electron = read('../electron-builder.yml');
const releaseBuilder = read('../scripts/build-windows-release.ps1');

test('Registry V4 deployer is standalone and absent from the FLAP App', () => {
  assert.doesNotMatch(server, /registry-v4/i);
  assert.doesNotMatch(cartridge, /registry-v4/i);
  assert.doesNotMatch(electron, /deployment\/|registry-v4/i);
  assert.match(releaseBuilder, /standaloneDeployer/);
  assert.match(releaseBuilder, /packagedInApp\s*=\s*\$false/);
  assert.match(template, /与 FLAP App 分离的单文件工具/);
  assert.match(template, /不读取 App 钱包、数据目录或本机服务/);
});

test('standalone deployer fixes the artifact and uses only an injected wallet', () => {
  for (const phrase of [
    'window.ethereum',
    'DEPLOY_OFFICIAL_REGISTRY_V4',
    'PUBLISH_ONE_TIME_TEST_CARTRIDGE',
    'expectedRuntimeCode',
    '创世区块不匹配',
    'calldataRecovered',
    'duplicateRejected',
    'metadataImageVerified',
    'COVER_URL',
    'COVER_SHA256',
    '确认部署官方主网合约',
    '确认执行主网卡带测试',
  ]) assert.ok(source.includes(phrase), `standalone deployer source missing ${phrase}`);
  assert.doesNotMatch(source, /privateKey|mnemonic|local-wallet|\/api\/registry-v4/i);
  assert.match(builder, /fly-cartridge-v4-registry-candidate\.json/);
  assert.match(builder, /bundle:\s*true/);
});

test('generated deployer is one self-contained HTML release asset', () => {
  const artifact = readFileSync(new URL(
    '../artifacts/fly-cartridge-v4-registry-candidate.json', import.meta.url));
  const artifactSha256 = crypto.createHash('sha256').update(artifact).digest('hex');
  assert.ok(output.length > 300_000, 'generated HTML unexpectedly small');
  assert.ok(output.includes(artifactSha256));
  assert.match(output, /fly-cartridge-v3-0ec7c8477b27\.png/);
  assert.match(output, /DEPLOY_OFFICIAL_REGISTRY_V4/);
  assert.match(output, /PUBLISH_ONE_TIME_TEST_CARTRIDGE/);
  assert.doesNotMatch(output, /<script[^>]+src=/i);
  assert.doesNotMatch(output, /<link[^>]+stylesheet/i);
  assert.doesNotMatch(output, /FLAP_STYLES|FLAP_SCRIPT/);
});
