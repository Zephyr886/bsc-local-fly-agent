import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "public", "index.html"), "utf8");
const css = readFileSync(join(here, "..", "public", "styles.css"), "utf8");

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
