import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");
const language = read("public", "language.js");
const css = read("public", "styles.css");
const server = read("src", "server.mjs");

test("三个本地界面都加载同一个双语控制器", () => {
  for (const page of ["index.html", "flies.html", "cartridge.html"]) {
    assert.match(read("public", page), /<script src="\/language\.js\?v=/, `${page} 缺少语言控制器`);
  }
  assert.match(server, /"\/language\.js": \{ root: publicDir, file: "language\.js" \}/);
});

test("语言选择会持久保存并向辅助技术暴露当前状态", () => {
  assert.match(language, /flap-agent-language/);
  assert.match(language, /localStorage\.setItem/);
  assert.match(language, /aria-pressed/);
  assert.match(language, /document\.documentElement\.lang/);
  assert.match(language, /MutationObserver/);
  assert.match(language, /window\.FLAP_LANGUAGE/);
});

test("中英文按钮满足触控尺寸并支持键盘焦点", () => {
  assert.match(css, /\.local-language-switch button\{[^}]*min-width:44px;[^}]*min-height:36px/);
  assert.match(css, /\.local-language-switch\{[^}]*min-height:44px/);
  assert.match(css, /\.local-language-switch button:focus-visible/);
});
