import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_PYTHON = process.platform === "win32"
  ? join(ROOT, "work", "full-brain-venv", "Scripts", "python.exe")
  : join(ROOT, "work", "full-brain-venv", "bin", "python");
const WORKER = join(ROOT, "server", "full-brain", "worker.py");
const DATA = join(ROOT, "data", "full-brain");
const REQUIRED_DATA = [
  join(DATA, "graph.npz"),
  join(DATA, "annotations.feather"),
  join(DATA, "normalized", "neurons.feather"),
];

export function fullBrainWorkerEnv(source = process.env) {
  // The connectome child receives only market frames through stdin. In
  // particular, wallet passwords, private keys and RPC credentials are never
  // inherited by the Python process.
  const allowed = [
    "PATH", "LD_LIBRARY_PATH", "HOME", "USER", "USERPROFILE",
    "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR",
    "FULL_BRAIN_CHECKPOINT", "FULL_BRAIN_META", "FULL_BRAIN_LATEST_INPUT",
  ];
  const env = Object.fromEntries(allowed
    .filter((key) => source[key] !== undefined)
    .map((key) => [key, source[key]]));
  env.STONKFLY_DATA = source.STONKFLY_DATA || DATA;
  env.OPENBLAS_NUM_THREADS = "1";
  env.PYTHONUTF8 = "1";
  return env;
}

export class FullBrainClient {
  constructor({ python = process.env.FULL_BRAIN_PYTHON || DEFAULT_PYTHON,
    checkpoint = process.env.FULL_BRAIN_CHECKPOINT || join(DATA, "service.npz"),
    timeoutMs = 30_000 } = {}) {
    this.python = resolve(python);
    this.checkpoint = resolve(checkpoint);
    this.meta = resolve(process.env.FULL_BRAIN_META || this.checkpoint.replace(/\.npz$/i, ".json"));
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.pending = null;
    this.sequence = 0;
    this.status = "stopped";
    this.error = null;
    this.graph = null;
    this.retryAt = 0;
    this.lastStderr = "";
    this.stopping = false;
  }

  setupHint() {
    return "请先运行 npm run brain:setup 下载并校验 MaleCNS v1.0（约 1.03GiB 下载，约 1.58GiB 数据目录）";
  }

  start() {
    if (this.child || this.stopping || Date.now() < this.retryAt) return;
    if (!existsSync(this.python)) {
      this.status = "setup-required";
      this.error = `找不到全脑 Python 环境：${this.python}；${this.setupHint()}`;
      return;
    }
    if (!existsSync(WORKER)) {
      this.status = "error";
      this.error = `找不到全脑 worker：${WORKER}`;
      return;
    }
    const missingData = REQUIRED_DATA.filter((path) => !existsSync(path));
    if (missingData.length) {
      this.status = "setup-required";
      this.error = `缺少全脑连接组数据：${missingData[0]}；${this.setupHint()}`;
      return;
    }

    const child = spawn(this.python, ["-u", WORKER], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: fullBrainWorkerEnv({ ...process.env, FULL_BRAIN_CHECKPOINT: this.checkpoint,
        FULL_BRAIN_META: this.meta,
        FULL_BRAIN_LATEST_INPUT: join(dirname(this.checkpoint), "latest-input.png") }),
      windowsHide: true,
    });
    this.child = child;
    this.status = "starting";
    this.error = null;
    this.lastStderr = "";
    child.stderr.on("data", (data) => {
      const message = data.toString().trim();
      if (!message) return;
      this.lastStderr = `${this.lastStderr}\n${message}`.trim().slice(-4000);
      console.error("[full-brain]", message.slice(0, 1000));
    });
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code) => {
      if (this.child !== child || this.stopping) return;
      this.child = null;
      const detail = this.lastStderr.split(/\r?\n/).filter(Boolean).at(-1);
      this.fail(new Error(detail || `全脑进程已退出（code ${code ?? "unknown"}）；${this.setupHint()}`));
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.ready) {
          this.status = "ready";
          this.error = null;
          this.graph = message.graph;
          return;
        }
        if (message.id !== this.pending?.id) return;
        const pending = this.pending;
        clearTimeout(pending.timer);
        this.pending = null;
        this.status = "ready";
        if (message.error) {
          this.error = message.error;
          pending.reject(new Error(message.error));
        } else {
          this.error = null;
          pending.resolve(message.result);
        }
      } catch (error) {
        this.fail(error);
      }
    });
  }

  fail(error) {
    this.error = error instanceof Error ? error.message : String(error);
    this.status = this.error.includes("找不到全脑 Python") ? "setup-required" : "error";
    this.retryAt = Date.now() + 5_000;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = null;
    }
    const child = this.child;
    this.child = null;
    child?.kill();
  }

  observe(params) {
    if (this.stopping) return null;
    this.start();
    if (this.status !== "ready" || this.pending) return null;
    return this.request("observe", params);
  }

  request(method, params = {}) {
    if (!this.child?.stdin?.writable) throw new Error("全脑 worker 尚未就绪");
    const promise = new Promise((resolvePromise, rejectPromise) => {
      const id = ++this.sequence;
      const timer = setTimeout(
        () => this.fail(new Error("全脑计算超时，本轮提案已丢弃")),
        this.timeoutMs,
      );
      this.pending = { id, resolve: resolvePromise, reject: rejectPromise, timer };
      this.status = "computing";
      this.child.stdin.write(`${JSON.stringify({ ...params, method, id })}\n`);
    });
    this.current = promise;
    return promise;
  }

  snapshot() {
    return {
      status: this.status,
      error: this.error,
      graph: this.graph,
      python: this.python,
      dataDirectory: process.env.STONKFLY_DATA || DATA,
      checkpoint: this.checkpoint,
      meta: this.meta,
      pending: Boolean(this.pending),
    };
  }

  async park() {
    this.stopping = true;
    try {
      if (this.pending) await this.current;
      if (this.child && this.status === "ready") await this.request("save");
      const child = this.child;
      this.child = null;
      child?.kill();
      this.status = "stopped";
      this.graph = null;
    } finally { this.stopping = false; }
  }

  activateCheckpoint(checkpoint) {
    if (this.child || this.pending || this.stopping) {
      throw new Error("请先暂停本地运行时并等待全脑 worker 停止");
    }
    this.checkpoint = resolve(checkpoint);
    this.meta = this.checkpoint.replace(/\.npz$/i, ".json");
    this.status = "stopped";
    this.error = null;
    this.retryAt = 0;
  }

  async stop() {
    this.stopping = true;
    if (this.pending) await this.current.catch(() => {});
    if (this.child && !this.pending && this.status === "ready") await this.request("save").catch(() => {});
    const child = this.child;
    this.child = null;
    child?.kill();
    this.status = "stopped";
  }
}
