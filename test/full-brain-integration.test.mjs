import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SimulationRuntime } from "../src/agent/simulation.mjs";
import { fullBrainWorkerEnv, validateFullBrainObservation } from "../src/brain/full-brain-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const originalRoot = join(root, "..");
const sha = (path) => createHash("sha256")
  .update(readFileSync(path, "utf8").replace(/\r\n/g, "\n"))
  .digest("hex");
const controlledPortableOverrides = new Map([
  // WP-06 adds the strict Fly Profile identity/checkpoint protocol around the
  // preserved MaleCNS controller without changing the upstream neural model.
  ["server/full-brain/worker.py", "f639e018e28e3c71fb308999271f4b221535647e9ae6f7f1cab5a7bdf757302f"],
  // The downloadable runtime intentionally accepts equivalent LF/CRLF source
  // provenance so a learned cartridge can move between Windows and Linux.
  ["vendor/stonkfly/stonkfly/neural/brain.py", "b34336083d49b70e8ebd81b578b34b649f1b1af2861b60b83dfbca13df1f71f5"],
]);

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
    for (const path of paths) {
      const portable = `${directory.replaceAll("\\", "/")}/${path.replaceAll("\\", "/")}`;
      const override = controlledPortableOverrides.get(portable);
      if (override) assert.equal(sha(join(local, path)), override, `${portable} 受控可移植补丁必须保持不变`);
      else assert.equal(sha(join(local, path)), sha(join(original, path)), `${directory}/${path}`);
    }
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

test("全脑 client 在进入 Python 前拒绝未知或不完整的 Profile 请求", () => {
  const request = {
    tokenAddress: "0x0000000000000000000000000000000000000001",
    symbol: "TOKEN",
    history: [1],
    price: 1,
    pulse: "none",
    pulseStrength: 0,
    learning: false,
    neuralMs: 500,
    thresholdHz: 2,
    checkpointEverySeconds: 60,
    flyId: "11111111-1111-4111-8111-111111111111",
    profileRevision: 1,
    profileHash: `sha256:${"a".repeat(64)}`,
    modelVersion: "malecns-v1",
  };
  assert.equal(validateFullBrainObservation(request), request);
  assert.throws(() => validateFullBrainObservation({ ...request, privateKey: "secret" }), /未知字段/);
  const incomplete = { ...request };
  delete incomplete.flyId;
  assert.throws(() => validateFullBrainObservation(incomplete), /缺少字段/);
  assert.throws(() => validateFullBrainObservation({ ...request, neuralMs: 20 }), /市场或神经参数无效/);
  assert.throws(() => validateFullBrainObservation({ ...request, pulse: "buy" }), /市场或神经参数无效/);
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
