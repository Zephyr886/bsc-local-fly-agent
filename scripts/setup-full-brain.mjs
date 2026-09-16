import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENV = join(ROOT, "work", "full-brain-venv");
const VENV_PYTHON = process.platform === "win32"
  ? join(VENV, "Scripts", "python.exe")
  : join(VENV, "bin", "python");
const REQUIREMENTS = join(ROOT, "server", "full-brain", process.platform === "win32" ? "requirements.txt" : "requirements-linux.txt");
const MAIN = join(ROOT, "server", "full-brain", "main.py");

function run(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function locatePython() {
  if (process.env.FULL_BRAIN_BOOTSTRAP_PYTHON) return process.env.FULL_BRAIN_BOOTSTRAP_PYTHON;
  for (const candidate of process.platform === "win32" ? ["py", "python"] : ["python3", "python"]) {
    const args = candidate === "py" ? ["-3", "-c", "import sys; print(sys.executable)"] : ["-c", "import sys; print(sys.executable)"];
    const result = spawnSync(candidate, args, { encoding: "utf8", windowsHide: true });
    if (result.status === 0) return { command: candidate, prefix: candidate === "py" ? ["-3"] : [] };
  }
  throw new Error("未找到 Python 3。请安装 Python 3.12+ 后重试，或设置 FULL_BRAIN_BOOTSTRAP_PYTHON。");
}

mkdirSync(join(ROOT, "work"), { recursive: true });
if (!existsSync(VENV_PYTHON)) {
  const bootstrap = locatePython();
  if (typeof bootstrap === "string") run(bootstrap, ["-m", "venv", VENV]);
  else run(bootstrap.command, [...bootstrap.prefix, "-m", "venv", VENV]);
}

run(VENV_PYTHON, ["-m", "pip", "install", "--upgrade", "pip"]);
run(VENV_PYTHON, ["-m", "pip", "install", "-r", REQUIREMENTS]);
console.log("MaleCNS v1.0 将从官方发布地址下载并执行 SHA-256 校验。原始下载约 1.03GiB，完整数据目录约 1.58GiB。");
run(VENV_PYTHON, [MAIN, "prepare"]);
run(VENV_PYTHON, [MAIN, "verify"]);
console.log("全脑连接组已安装并校验完成。现在可运行 npm start。");
