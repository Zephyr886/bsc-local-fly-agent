import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

export const PYTHON_VERSION = "3.12.10";
export const PYTHON_INSTALLER_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-amd64.exe`;
export const PYTHON_INSTALLER_SHA256 = "67b5635e80ea51072b87941312d00ec8927c4db9ba18938f7ad2d27b328b95fb";

export function windowsRuntimePaths({ userData, runtimeRoot }) {
  const workRoot = join(userData, "work");
  const dataRoot = join(userData, "data");
  const pythonRoot = join(userData, "runtime", `python-${PYTHON_VERSION}`);
  const venvRoot = join(workRoot, "full-brain-venv");
  return {
    userData,
    runtimeRoot,
    workRoot,
    dataRoot,
    pythonRoot,
    python: join(pythonRoot, "python.exe"),
    venvRoot,
    venvPython: join(venvRoot, "Scripts", "python.exe"),
    installer: join(userData, "downloads", `python-${PYTHON_VERSION}-amd64.exe`),
    requirements: join(runtimeRoot, "server", "full-brain", "requirements.txt"),
    brainMain: join(runtimeRoot, "server", "full-brain", "main.py"),
    brainData: join(dataRoot, "full-brain"),
  };
}

export function brainReady(paths) {
  return [
    paths.venvPython,
    join(paths.brainData, "graph.npz"),
    join(paths.brainData, "annotations.feather"),
    join(paths.brainData, "normalized", "neurons.feather"),
  ].every(existsSync);
}

async function sha256(path) {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function download(url, target, onProgress, signal) {
  await mkdir(dirname(target), { recursive: true });
  if (existsSync(target) && await sha256(target) === PYTHON_INSTALLER_SHA256) {
    onProgress({ stage: "python-download", percent: 100, message: "已使用校验通过的 Python 安装器缓存" });
    return;
  }
  const temporary = `${target}.partial`;
  await rm(temporary, { force: true });
  const response = await fetch(url, { redirect: "follow", signal });
  if (!response.ok || !response.body) throw new Error(`Python 下载失败（HTTP ${response.status}）`);
  const total = Number(response.headers.get("content-length") || 0);
  const reader = response.body.getReader();
  const handle = await open(temporary, "w");
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(value);
      received += value.byteLength;
      onProgress({
        stage: "python-download",
        percent: total ? Math.min(99, Math.round(received / total * 100)) : null,
        message: `正在下载私有 Python（${Math.round(received / 1048576)} / ${total ? Math.round(total / 1048576) : "?"} MiB）`,
      });
    }
  } finally {
    await handle.close();
  }
  if (await sha256(temporary) !== PYTHON_INSTALLER_SHA256) {
    await rm(temporary, { force: true });
    throw new Error("Python 安装器 SHA-256 校验失败，已拒绝执行");
  }
  await rm(target, { force: true });
  await rename(temporary, target);
  onProgress({ stage: "python-download", percent: 100, message: "Python 安装器下载并校验完成" });
}

function run(command, args, { cwd, env, onLine, signal } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    let tail = "";
    const collect = (chunk) => {
      const value = chunk.toString();
      tail = `${tail}${value}`.slice(-12_000);
      for (const line of value.split(/\r?\n/)) if (line.trim()) onLine?.(line.trim());
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return rejectRun(new Error("初始化已取消"));
      if (code === 0) resolveRun();
      else rejectRun(new Error(tail.trim().split(/\r?\n/).at(-1) || `命令执行失败（${code ?? "unknown"}）`));
    });
  });
}

export async function setupWindowsBrain(paths, { onProgress = () => {}, signal } = {}) {
  if (process.platform !== "win32") throw new Error("当前初始化器仅支持 Windows x64");
  await Promise.all([
    mkdir(paths.workRoot, { recursive: true }),
    mkdir(paths.dataRoot, { recursive: true }),
    mkdir(dirname(paths.pythonRoot), { recursive: true }),
  ]);
  if (brainReady(paths)) {
    onProgress({ stage: "complete", percent: 100, message: "全脑运行环境已经安装并通过文件检查" });
    return;
  }

  if (!existsSync(paths.python)) {
    await download(PYTHON_INSTALLER_URL, paths.installer, onProgress, signal);
    onProgress({ stage: "python-install", percent: null, message: "正在安装应用私有 Python，请稍候" });
    await run(paths.installer, [
      "/quiet", "InstallAllUsers=0", "Include_launcher=0", "AssociateFiles=0",
      "Shortcuts=0", "PrependPath=0", "Include_test=0", "Include_doc=0",
      "Include_tcltk=0", "Include_pip=1", `TargetDir=${paths.pythonRoot}`,
    ], { cwd: paths.userData, signal });
    if (!existsSync(paths.python)) throw new Error("Python 安装完成，但没有找到私有解释器");
  }

  const childEnv = {
    ...process.env,
    FLAP_RUNTIME_ROOT: paths.runtimeRoot,
    STONKFLY_DATA: paths.brainData,
    PYTHONPATH: join(paths.runtimeRoot, "vendor", "stonkfly"),
    OPENBLAS_NUM_THREADS: "1",
    PYTHONUTF8: "1",
  };
  const output = (stage) => (line) => onProgress({ stage, percent: null, message: line });

  if (!existsSync(paths.venvPython)) {
    onProgress({ stage: "venv", percent: null, message: "正在创建隔离的全脑 Python 环境" });
    await run(paths.python, ["-m", "venv", paths.venvRoot], {
      cwd: paths.runtimeRoot, env: childEnv, onLine: output("venv"), signal,
    });
  }
  onProgress({ stage: "dependencies", percent: null, message: "正在安装锁定的全脑计算依赖" });
  await run(paths.venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "-r", paths.requirements], {
    cwd: paths.runtimeRoot, env: childEnv, onLine: output("dependencies"), signal,
  });
  onProgress({ stage: "brain-data", percent: null, message: "正在下载并编译 MaleCNS v1.0（约 1.03 GiB）" });
  await run(paths.venvPython, ["-c", "from stonkfly.data import prepare; prepare()"], {
    cwd: paths.runtimeRoot, env: childEnv, onLine: output("brain-data"), signal,
  });
  onProgress({ stage: "verify", percent: null, message: "正在校验完整连接组与数据锁" });
  await run(paths.venvPython, ["-c", "import json; from stonkfly.data import verify; print(json.dumps(verify()))"], {
    cwd: paths.runtimeRoot, env: childEnv, onLine: output("verify"), signal,
  });
  if (!brainReady(paths)) throw new Error("全脑安装流程结束，但必需文件检查未通过");
  onProgress({ stage: "complete", percent: 100, message: "Windows 全脑运行环境安装完成" });
}

export async function cachedInstallerIsValid(paths) {
  try {
    return (await stat(paths.installer)).isFile() && await sha256(paths.installer) === PYTHON_INSTALLER_SHA256;
  } catch {
    return false;
  }
}
