import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const python = process.env.FULL_BRAIN_PYTHON || (process.platform === "win32"
  ? join(root, "work", "full-brain-venv", "Scripts", "python.exe")
  : join(root, "work", "full-brain-venv", "bin", "python"));
if (!existsSync(python)) {
  console.error("未找到全脑 Python 环境，请先运行 npm run brain:setup");
  process.exit(1);
}
const result = spawnSync(python, [join(root, "server", "full-brain", "main.py"), ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
