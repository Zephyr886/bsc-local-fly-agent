import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const html = readFileSync(join(root, "public", "flies.html"), "utf8");
const js = readFileSync(join(root, "public", "flies.js"), "utf8");
const css = readFileSync(join(root, "public", "styles.css"), "utf8");
const server = readFileSync(join(root, "src", "server.mjs"), "utf8");
const schema = JSON.parse(readFileSync(join(root, "schemas", "fly-profile-v1.schema.json"), "utf8"));

test("果蝇管理中心使用独立静态资源且符合 CSP", () => {
  assert.match(server, /"\/flies": \{ root: publicDir, file: "flies\.html" \}/);
  assert.match(server, /"\/flies\.js": \{ root: publicDir, file: "flies\.js" \}/);
  assert.match(html, /<script type="module" src="\/flies\.js\?v=/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /\son(?:click|change|submit|input)=/i);
  assert.doesNotMatch(js, /\.innerHTML\s*=|\beval\s*\(|new Function\s*\(/);
});

test("静态表单控件均有可见标签", () => {
  const controls = [...html.matchAll(/<(?:input|select)\b[^>]*\bid="([^"]+)"[^>]*>/g)].map((match) => match[1]);
  for (const id of controls) {
    const explicit = html.includes(`for="${id}"`);
    const wrapped = new RegExp(`<label[^>]*for="${id}"|<label[^>]*>[\\s\\S]*?id="${id}"`).test(html);
    assert.ok(explicit || wrapped, `${id} 应有可见 label`);
  }
});

test("Profile 七分区使用结构化表单并覆盖 schema 字段", () => {
  for (const section of ["universe", "perception", "learning", "reward", "strategy", "risk", "runtime"]) {
    assert.match(html, new RegExp(`data-section="${section}"`));
    for (const field of Object.keys(schema.$defs.spec.properties[section].properties)) {
      assert.ok(js.includes(`"${section}.${field}"`), `${section}.${field} 应有字段元数据`);
    }
  }
  assert.match(html, /id="mode-basic"/);
  assert.match(html, /id="mode-advanced"/);
  assert.doesNotMatch(html, /<textarea/i);
  assert.match(js, /state\.schema\.\$defs\.spec\.properties/);
});

test("保存影响、Effective Risk 与 revision 冲突不会静默覆盖", () => {
  assert.match(html, /id="change-paths"/);
  assert.match(html, /Effective Risk/);
  assert.match(html, /id="conflict-dialog"/);
  assert.match(js, /PROFILE_REVISION_CONFLICT/);
  assert.match(js, /重新应用到服务器新版本/);
  assert.match(js, /beforeunload/);
  assert.match(js, /pendingActivation/);
});

test("管理中心支持键盘、低动态和窄视口", () => {
  assert.match(js, /ArrowRight/);
  assert.match(js, /ArrowLeft/);
  assert.match(js, /event\.key === "Home"/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.fly-list-item/);
  assert.match(css, /@media \(max-width: 1280px\)[\s\S]*\.fly-inspector/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*font-size: 16px/);
  assert.match(html, /role="status" aria-live="polite"/);
});

test("训练、评估、版本回滚与卡带状态都接入真实 API", () => {
  assert.match(js, /\/training-runs\?limit=50/);
  assert.match(js, /\/evaluations\?limit=50/);
  assert.match(js, /\/rollback/);
  assert.match(js, /\/api\/cartridge\/status/);
  assert.match(html, /v4 状态/);
  assert.match(html, /id="publishability-reasons"/);
});
