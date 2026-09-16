import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SimulationRuntime } from "../src/agent/simulation.mjs";
import { fullBrainWorkerEnv } from "../src/brain/full-brain-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const originalRoot = join(root, "..");
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function filesBelow(path) {
  const found = [];
  for (const name of readdirSync(path)) {
    if (name === "__pycache__") continue;
    const item = join(path, name);
    if (statSync(item).isDirectory()) found.push(...filesBelow(item));
    else found.push(item);
  }
  return found;
}

test("受控的 MaleCNS 全连接组源码与主项目逐字一致", {
  skip: !existsSync(join(originalRoot, "server", "full-brain", "worker.py")),
}, () => {
  for (const directory of [join("server", "full-brain"), join("vendor", "stonkfly")]) {
    const local = join(root, directory);
    const original = join(originalRoot, directory);
    const paths = filesBelow(local).map((path) => relative(local, path)).sort();
    const originals = filesBelow(original).map((path) => relative(original, path)).sort();
    assert.deepEqual(paths, originals, `${directory} 文件清单必须一致`);
    for (const path of paths) assert.equal(sha(join(local, path)), sha(join(original, path)), `${directory}/${path}`);
  }
});

test("全脑 worker 不继承钱包、密码或 RPC 凭据", () => {
  const env = fullBrainWorkerEnv({
    PATH: "kept",
    EXECUTOR_PRIVATE_KEY: "secret",
    CONSOLE_PASSWORD: "password",
    BSC_RPC_URL: "private-rpc",
    WALLET_PASSWORD: "wallet-password",
    PYTHONPATH: "untrusted-python-path",
  });
  assert.equal(env.PATH, "kept");
  assert.equal(env.EXECUTOR_PRIVATE_KEY, undefined);
  assert.equal(env.CONSOLE_PASSWORD, undefined);
  assert.equal(env.BSC_RPC_URL, undefined);
  assert.equal(env.WALLET_PASSWORD, undefined);
  assert.equal(env.PYTHONPATH, undefined);
  assert.equal(env.OPENBLAS_NUM_THREADS, "1");
  assert.match(env.STONKFLY_DATA, /data[\\/]full-brain$/);
});

test("SimulationRuntime 将全连接组输出接入 Hybrid V2，而不是调用轻量脑作决策", async () => {
  const neural = {
    side: "HOLD",
    left_hz: 1,
    right_hz: 1,
    difference_hz: 0,
    gate_spikes: 2,
    KC_spikes: 17,
    total_spikes: 42,
    sample_activity: [0, 2, 3, 1],
    sample_active_count: 2,
    sampled_neurons: 12_781,
    graph: { release: "MaleCNS v1.0", neurons: 166_700, directed_edges: 25_582_938, arrays_verified: true },
  };
  const client = {
    status: "ready",
    error: null,
    graph: neural.graph,
    start() {},
    observe() { return Promise.resolve(neural); },
    snapshot() { return { status: this.status, error: this.error, graph: this.graph }; },
    async stop() {},
  };
  const runtime = new SimulationRuntime({ neuralClient: client });
  await runtime.start({ tokenAddress: "0x0000000000000000000000000000000000000001" });
  clearInterval(runtime.timer);
  runtime.timer = null;
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.brain.engine, "malecns-full-connectome");
  assert.equal(snapshot.fullBrain.latest.total_spikes, 42);
  assert.deepEqual(snapshot.latestDecision.fullBrain.sample_activity, [0, 2, 3, 1]);
  assert.equal(snapshot.latestDecision.flyBrain, undefined);
  await runtime.close();
});
