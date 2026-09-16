import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "public", "index.html"), "utf8");
const css = readFileSync(join(here, "..", "public", "styles.css"), "utf8");
const scene = readFileSync(join(here, "..", "public", "scene.js"), "utf8");
const maleCns = JSON.parse(readFileSync(join(here, "..", "public", "malecns-points.json"), "utf8"));

test("每个表单控件都有可见标签", () => {
  const controls = [...html.matchAll(/<(?:input|select)\b[^>]*\bid="([^"]+)"[^>]*>/g)].map((match) => match[1]);
  for (const id of controls) {
    const explicit = html.includes(`for="${id}"`);
    const wrapped = new RegExp(`<label[^>]*>[^<]*(?:<[^>]+>[^<]*)*<(?:input|select)[^>]+id="${id}"`, "s").test(html);
    assert.ok(explicit || wrapped, `${id} 应有 label`);
  }
});

test("页面不包含内联脚本并支持低动态偏好", () => {
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /aria-live="polite"/);
});

test("3D 数字孪生包含双场景并接收运行时状态", () => {
  assert.match(html, /id="fly-stage"/);
  assert.match(html, /id="brain-stage"/);
  assert.match(html, /id="motor-buy"/);
  assert.match(html, /id="motor-burn"/);
  assert.match(html, /id="chart-summary"/);
  assert.match(html, /src="\/scene\.js\?v=/);
  assert.match(scene, /from "\/vendor\/three\.module\.js"/);
  assert.match(scene, /flyruntime:update/);
  assert.match(scene, /latestBrainMotorEvent/);
  assert.match(scene, /paintChart/);
  assert.match(scene, /new THREE\.WebGLRenderer/);
  assert.match(scene, /fetch\("\/malecns-points\.json"/);
  assert.doesNotMatch(scene, /randomPointInEllipsoid/);
  assert.equal(maleCns.meta.dataset, "MaleCNS v1.0");
  assert.equal(maleCns.meta.pointsInFile, 12_781);
  assert.equal(maleCns.points.length / maleCns.stride, 12_781);
});

test("实盘使用本地加密钱包且保留逐笔确认", () => {
  assert.match(html, /id="wallet-setup-dialog"/);
  assert.match(html, /id="wallet-private-key" type="password"/);
  assert.match(html, /id="wallet-password" type="password"/);
  assert.match(html, /id="sign-password" type="password"/);
  assert.match(html, /确认主网交易/);
  assert.match(scene + readFileSync(join(here, "..", "public", "app.js"), "utf8"), /\/api\/transaction\/sign-send/);
  assert.doesNotMatch(readFileSync(join(here, "..", "public", "app.js"), "utf8"), /window\.ethereum/);
});
