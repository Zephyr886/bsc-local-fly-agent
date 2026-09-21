import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ACTIVATION_MODES_BY_PATH } from "../src/profile/activation.mjs";
import { DEFAULT_PROFILE_SPEC } from "../src/profile/defaults.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");
const readme = read("README.md");
const fieldReference = read("docs", "FLY_PROFILE_V1_FIELD_REFERENCE.md");
const replayReference = read("docs", "DETERMINISTIC_REPLAY_DATASET_V1.md");
const backup = read("docs", "BACKUP_AND_RECOVERY.md");
const release = read("docs", "FLY_PROFILE_V1_RELEASE_CANDIDATE.md");
const schema = JSON.parse(read("schemas", "fly-profile-v1.schema.json"));
const builder = read("electron-builder.yml");
const changelog = read("CHANGELOG.md");
const releaseNotes = read("docs", "RELEASE_NOTES_V4.0.0.md");
const rollback = read("docs", "ROLLBACK_V4.0.0.md");
const cleanVm = read("docs", "CLEAN_VM_ACCEPTANCE_V4.0.0.md");
const securityReview = read("docs", "SECURITY_LICENSE_REVIEW_V4.0.0.md");
const releaseBuild = read("scripts", "build-windows-release.ps1");

function flatten(value, prefix = "") {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === "object" && !Array.isArray(child)
      ? flatten(child, path)
      : [[path, child]];
  });
}

function documentedFields(markdown) {
  const rows = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^\| `([^`]+)` \| `([^`]+)` \| .* \| `([^`]+)` \|$/);
    if (!match) continue;
    rows.set(match[1], { defaultValue: JSON.parse(match[2]), activation: match[3] });
  }
  return rows;
}

test("字段手册的默认值与生效模式逐字段匹配运行时合同", () => {
  const documented = documentedFields(fieldReference);
  const defaults = new Map(flatten(DEFAULT_PROFILE_SPEC));
  assert.equal(documented.size, defaults.size);
  for (const [path, defaultValue] of defaults) {
    assert.deepEqual(documented.get(path)?.defaultValue, defaultValue, `${path} 默认值必须一致`);
    assert.equal(documented.get(path)?.activation,
      ACTIVATION_MODES_BY_PATH[`/spec/${path.replace(".", "/")}`], `${path} 生效模式必须一致`);
  }
  assert.match(fieldReference, /默认值和内置预设[^\n]+不代表盈利能力/);
});

test("JSON Schema 的字段默认值与运行时默认 Profile 一致", () => {
  for (const [section, values] of Object.entries(DEFAULT_PROFILE_SPEC)) {
    const properties = schema.$defs.spec.properties[section].properties;
    for (const [field, value] of Object.entries(values)) {
      assert.deepEqual(properties[field].default, value, `${section}.${field} Schema default 必须一致`);
    }
  }
});

test("README 覆盖创建、训练、切换、评估、导出和稳定数据路径", () => {
  for (const phrase of ["创建果蝇", "设为活动", "确定性回放", "评估强制冻结学习",
    "从当前大脑导出卡带", "data/flies/<fly-id>/", "data/active-fly.json"]) {
    assert.ok(readme.includes(phrase), `README 缺少 ${phrase}`);
  }
  for (const route of ["/api/fly-profile/schema", "/api/flies/:flyId/profile",
    "/api/flies/:flyId/training-runs", "/api/flies/:flyId/evaluations",
    "/api/cartridge/import-file", "/api/cartridge/export/:id/:name"]) {
    assert.ok(readme.includes(route), `README 缺少 ${route}`);
  }
});

test("备份清单把 Profile、checkpoint、SQLite、卡带和钱包密文分开", () => {
  for (const phrase of ["Profile 与活动指针", "Checkpoint", "SQLite", "卡带", "钱包密文",
    "local-wallet.vault.json", "-wal", "-shm", "SHA-256"]) {
    assert.ok(backup.includes(phrase), `备份文档缺少 ${phrase}`);
  }
  assert.match(backup, /钱包密码[^\n]+另一个安全通道/);
});

test("回放数据集规范覆盖运行时字段和 K 线转换风险", () => {
  const required = ["format", "version", "tokenAddress", "symbol", "observations", "assumptions",
    "at", "history", "market", "flow", "token", "positionPercentile", "position", "activity",
    "priceActivity", "volumeActivity", "minIntervalSeconds", "volumeRatio", "priceSamples", "updatedAt",
    "scannedAt", "error", "windows", "m5", "buyVolume", "sellVolume", "quotePrice", "buyTaxPercent",
    "liquidity", "quote", "feePercent", "slippagePercent", "gasBnb", "initialQuote", "initialToken", "initialBnb"];
  for (const field of required) assert.ok(replayReference.includes(`\`${field}\``), `回放规范缺少 ${field}`);
  for (const phrase of ["每项相隔 1 秒", "分钟 K 线", "普通 OHLCV 不能证明主动买/卖方向",
    "sidecar", "16 MiB", "SHA-256", "不能静默把分钟 K 线当作秒数据"]) {
    assert.ok(replayReference.includes(phrase), `回放规范缺少 ${phrase}`);
  }
  assert.ok(readme.includes("docs/DETERMINISTIC_REPLAY_DATASET_V1.md"));
});

test("RC 文档明确区分 v3/v4 卡带与 Registry V3/V4", () => {
  for (const phrase of ["Fly Cartridge v3", "Fly Cartridge v4", "Registry V3", "Registry V4",
    "不可直接发布到 Registry V3", "当前未设计冻结、未部署、无地址", "未签名小范围测试发行版"]) {
    assert.ok(release.includes(phrase), `RC 文档缺少 ${phrase}`);
  }
  assert.match(builder, /deleteAppDataOnUninstall:\s*false/);
  assert.match(builder, /runAfterFinish:\s*false/);
});

test("4.0.0 发布资料覆盖未签名限制、升级回滚和后续干净 VM 验收", () => {
  for (const phrase of ["Profile v1", "多果蝇", "Registry V3", "SmartScreen"]) {
    assert.ok(changelog.includes(phrase), `CHANGELOG 缺少 ${phrase}`);
  }
  for (const phrase of ["FLAP-Fly-Agent-Setup-4.0.0.exe", "SHA256SUMS.txt", "不包含 Registry V4",
    "npm run release:build:win:unsigned", "不是开放源码"]) {
    assert.ok(releaseNotes.includes(phrase), `发布说明缺少 ${phrase}`);
  }
  for (const phrase of ["deleteAppDataOnUninstall", "SQLite", "-wal", "-shm"]) {
    assert.ok(rollback.includes(phrase), `回滚说明缺少 ${phrase}`);
  }
  for (const phrase of ["首次初始化", "覆盖升级", "卸载保留数据", "不能把同机隔离目录测试冒充成干净 VM证据".replace("VM证据", "VM 证据")]) {
    assert.ok(cleanVm.includes(phrase), `干净 VM 说明缺少 ${phrase}`);
  }
  for (const phrase of ["npm audit", "0 漏洞", "常见 PEM 私钥", "顶层 `LICENSE`", "`NotSigned`", "GitHub CLI"]) {
    assert.ok(securityReview.includes(phrase), `安全审查缺少 ${phrase}`);
  }
  for (const phrase of ["Unsigned", "CSC_IDENTITY_AUTO_DISCOVERY", "Get-AuthenticodeSignature", "SHA256SUMS.txt", "release-manifest.json"]) {
    assert.ok(releaseBuild.includes(phrase), `签名构建脚本缺少 ${phrase}`);
  }
});
