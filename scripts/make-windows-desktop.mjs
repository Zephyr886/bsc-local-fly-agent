import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32") throw new Error("Windows installer must be built on Windows");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

let buildRoot = root;
let alias = null;
try {
  // Windows packaging tools still contain helpers that may fail when a parent
  // directory contains non-ASCII characters. Keep output in the repository but
  // present an ASCII path to those helpers while the build runs.
  if (/[^\x20-\x7e]/.test(root)) {
    const letter = ["R", "Q", "P", "O"].find((name) => !existsSync(`${name}:\\`));
    if (!letter) throw new Error("找不到可用于 Windows 打包的空闲临时盘符");
    alias = `${letter}:`;
    run("subst.exe", [alias, root], root);
    buildRoot = `${alias}\\`;
    console.log(`Windows build path alias: ${buildRoot} -> ${root}`);
  }
  const builder = join(buildRoot, "node_modules", "electron-builder", "cli.js");
  run(process.execPath, [builder, "--win", "nsis", "--x64"], buildRoot);
} finally {
  if (alias) spawnSync("subst.exe", [alias, "/d"], { stdio: "ignore", windowsHide: true });
}
