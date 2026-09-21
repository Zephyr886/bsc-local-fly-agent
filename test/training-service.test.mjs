import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { FlyManager } from "../src/flies/fly-manager.mjs";
import { FlyRepository } from "../src/flies/fly-repository.mjs";
import { SqliteStore } from "../src/persistence/sqlite-store.mjs";
import { EvaluationService } from "../src/training/evaluation-service.mjs";
import { sha256File } from "../src/training/shared.mjs";
import { TrainingService } from "../src/training/training-service.mjs";

const TOKEN = "0x1111111111111111111111111111111111111111";

class FakeBrainClient {
  constructor({ checkpoint = join(tmpdir(), `${randomUUID()}.npz`), meta = checkpoint.replace(/\.npz$/, ".json") } = {}) {
    this.checkpoint = checkpoint;
    this.meta = meta;
    this.status = "stopped";
    this.error = null;
    this.requests = [];
    this.lastRequest = null;
    this.pending = null;
  }

  activateCheckpoint(path) {
    this.checkpoint = path;
    this.meta = path.replace(/\.npz$/, ".json");
  }

  start() { this.status = "ready"; }

  async observe(request) {
    this.requests.push(structuredClone(request));
    this.lastRequest = request;
    return {
      side: "BUY",
      difference_hz: 8,
      gate_spikes: 4,
      compute_seconds: 0.25,
      rssMb: 128,
    };
  }

  async park() {
    if (this.lastRequest) {
      await mkdir(dirname(this.checkpoint), { recursive: true });
      const payload = `checkpoint:${this.lastRequest.flyId}:${this.lastRequest.modelVersion}:${this.lastRequest.learning}`;
      await writeFile(this.checkpoint, payload);
      await writeFile(this.meta, `${JSON.stringify({
        flyId: this.lastRequest.flyId,
        profileRevision: this.lastRequest.profileRevision,
        profileHash: this.lastRequest.profileHash,
        modelVersion: this.lastRequest.modelVersion,
        tokenAddress: this.lastRequest.tokenAddress,
        tokenContext: { address: this.lastRequest.tokenAddress, symbol: this.lastRequest.symbol },
        learningEnabled: this.lastRequest.learning,
        savedAt: "2026-09-20T00:00:00.000Z",
        weightSha256: createHash("sha256").update(payload).digest("hex"),
      })}\n`);
    }
    this.status = "stopped";
  }

  snapshot() { return { status: this.status }; }
}

class FakeSimulation {
  constructor(brain) {
    this.brainClient = brain;
    this.state = { status: "stopped" };
    this.activationContext = null;
    this.config = { fullFeePercent: 0.6, fullGasBnb: 0.00003 };
    this.hybrid = { state: { decisions: [], feedbackQueue: [] } };
  }

  setActivationContext(context) { this.activationContext = context; }

  async start({ activationContext, tokenAddress }) {
    this.activationContext = activationContext;
    this.state = { status: "running", sessionId: randomUUID() };
    this.brainClient.lastRequest = {
      flyId: activationContext.flyId,
      profileRevision: activationContext.revision,
      profileHash: activationContext.profileHash,
      modelVersion: "malecns-v1",
      tokenAddress,
      symbol: "LIVE",
      learning: activationContext.effectiveProfile.spec.learning.enabled,
    };
    this.hybrid.state.decisions = [{
      at: "2026-09-20T00:00:00.000Z",
      actions: { hybrid: { action: "BUY" } },
      executions: { hybrid: { status: "simulated", action: "buy" } },
      runtimeMetrics: { simulatedNetAssetValue: 100, neuralComputeSeconds: 0.2, rssMb: 120 },
    }, {
      at: "2026-09-20T00:01:00.000Z",
      actions: { hybrid: { action: "HOLD" } },
      executions: { hybrid: { status: "blocked", reason: "interval" } },
      runtimeMetrics: { simulatedNetAssetValue: 99, neuralComputeSeconds: 0.3, rssMb: 130 },
    }];
    this.hybrid.state.feedbackQueue = [{ utility: 0.25 }];
    return this.state;
  }

  stop() {
    this.state.status = "stopped";
    return { ...this.state };
  }

  reset() { this.state = { status: "stopped" }; return this.state; }
  async close() {}
}

function replayDataset() {
  const observations = [];
  for (let index = 0; index < 3; index += 1) {
    const at = new Date(Date.parse("2026-09-20T00:00:00.000Z") + index * 300_000).toISOString();
    const history = Array.from({ length: 60 }, (_, historyIndex) => 1.1 - historyIndex / 10_000 - index / 1_000);
    observations.push({
      at,
      history,
      market: {
        positionPercentile: 0.2,
        position: 0,
        activity: 0.8,
        priceActivity: 0.8,
        volumeActivity: 0.8,
        minIntervalSeconds: 60,
        volumeRatio: 1,
        priceSamples: 60,
        updatedAt: at,
      },
      flow: { scannedAt: at, error: null, windows: { m5: { buyVolume: 1, sellVolume: 2 } } },
      token: { quotePrice: 1, buyTaxPercent: 0, liquidity: { quote: 1_000, token: 1_000_000 } },
    });
  }
  return {
    format: "flap-deterministic-replay",
    version: 1,
    tokenAddress: TOKEN,
    symbol: "TEST",
    observations,
    assumptions: {
      feePercent: 0.6,
      slippagePercent: 1,
      gasBnb: 0.00003,
      initialQuote: 100,
      initialToken: 1_000_000,
      initialBnb: 1,
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flap-training-service-"));
  const dataRoot = join(root, "data");
  const replayRoot = join(dataRoot, "replay-datasets");
  await mkdir(replayRoot, { recursive: true });
  await writeFile(join(replayRoot, "fixture.json"), `${JSON.stringify(replayDataset())}\n`);
  const repository = new FlyRepository({ dataRoot });
  const store = new SqliteStore(join(dataRoot, "agent.sqlite"));
  const brain = new FakeBrainClient();
  const simulation = new FakeSimulation(brain);
  const manager = new FlyManager({
    repository,
    brainClient: brain,
    simulation,
    deck: { active: null, runCheckpoint() { return null; } },
    legacyCheckpoint: join(root, "missing.npz"),
  });
  await manager.init();
  const fly = await repository.create({ name: "Training fly" });
  await manager.activate(fly.id);
  return { root, dataRoot, replayRoot, repository, store, brain, simulation, manager, fly };
}

async function seedCheckpoint(context, repository) {
  const checkpoint = repository.checkpointFilePath(context.flyId, context.checkpointId);
  await writeFile(checkpoint, "original-checkpoint");
  await writeFile(repository.checkpointMetadataPath(context.flyId, context.checkpointId), `${JSON.stringify({
    flyId: context.flyId,
    profileRevision: context.revision,
    profileHash: context.profileHash,
    modelVersion: "malecns-v1",
    tokenAddress: TOKEN,
    tokenContext: { address: TOKEN, symbol: "TEST" },
    learningEnabled: true,
    savedAt: "2026-09-20T00:00:00.000Z",
    weightSha256: "a".repeat(64),
  })}\n`);
  return checkpoint;
}

test("live training freezes provenance, binds the session and saves a verified checkpoint before completion", async () => {
  const env = await fixture();
  const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"];
  const service = new TrainingService({ ...env, idFactory: () => ids.shift() });
  await service.init();
  const running = await service.startLive({ flyId: env.fly.id, tokenAddress: TOKEN });
  assert.equal(running.status, "running");
  assert.equal(env.simulation.activationContext.trainingRunId, running.id);
  assert.equal(running.profileHash, env.manager.context.profileHash);

  const completed = await service.stop(running.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.checkpointAfter.exists, true);
  assert.equal(completed.summary.metrics.observations, 2);
  assert.equal(completed.summary.metrics.actionCounts.BUY, 1);
  const file = JSON.parse(await readFile(env.repository.trainingRunFilePath(env.fly.id, running.id), "utf8"));
  assert.equal(file.profileRevision, env.manager.context.revision);
  assert.equal(file.checkpointAfter.metadata.flyId, env.fly.id);
  env.store.close();
});

test("startup marks abandoned running training as interrupted instead of completed", async () => {
  const env = await fixture();
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  env.store.createTrainingRun({
    id,
    flyId: env.fly.id,
    profileRevision: env.manager.context.revision,
    profileHash: env.manager.context.profileHash,
    tokenAddress: TOKEN,
    mode: "live-observation",
    status: "running",
    startedAt: "2026-09-20T00:00:00.000Z",
    checkpointBefore: null,
    summary: {},
  });
  const service = new TrainingService({ ...env });
  const interrupted = await service.init();
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].status, "interrupted");
  const file = JSON.parse(await readFile(env.repository.trainingRunFilePath(env.fly.id, id), "utf8"));
  assert.equal(file.summary.error.code, "PROCESS_INTERRUPTED");

  const evaluationId = "abababab-abab-4bab-8bab-abababababab";
  env.store.createEvaluation({
    id: evaluationId,
    flyId: env.fly.id,
    profileRevision: env.manager.context.revision,
    checkpointId: env.manager.context.checkpointId,
    datasetHash: `sha256:${"b".repeat(64)}`,
    status: "running",
    metrics: { source: { kind: "test" } },
    createdAt: "2026-09-20T00:00:00.000Z",
  });
  const evaluations = new EvaluationService({ ...env });
  const failed = await evaluations.init();
  assert.equal(failed[0].status, "failed");
  assert.equal(failed[0].metrics.error.code, "PROCESS_INTERRUPTED");
  env.store.close();
});

test("an initial training artifact failure leaves the SQLite run failed, never running", async () => {
  const env = await fixture();
  const id = "acacacac-acac-4cac-8cac-acacacacacac";
  const service = new TrainingService({ ...env, idFactory: () => id });
  env.repository.get = async () => { throw Object.assign(new Error("disk unavailable"), { code: "EIO" }); };
  await assert.rejects(service.startLive({ flyId: env.fly.id, tokenAddress: TOKEN }), /disk unavailable/);
  const failed = env.store.getTrainingRun(id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.summary.error.code, "EIO");
  env.store.close();
});

test("deterministic replay is rooted locally, records the dataset hash and completes lineage", async () => {
  const env = await fixture();
  const service = new TrainingService({
    ...env,
    idFactory: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  });
  await assert.rejects(service.runReplay({ flyId: env.fly.id, datasetPath: "../outside.json" }), /允许的数据目录/);
  const completed = await service.runReplay({ flyId: env.fly.id, datasetPath: "fixture.json" });
  assert.equal(completed.status, "completed");
  assert.match(completed.summary.source.datasetHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(completed.summary.metrics.observations, 3);
  assert.equal(completed.checkpointAfter.metadata.flyId, env.fly.id);
  assert.ok(env.brain.requests.every((request) => request.flyId === env.fly.id));
  env.store.close();
});

test("evaluation uses a frozen temporary checkpoint and repeats the deterministic summary", async () => {
  const env = await fixture();
  const checkpoint = await seedCheckpoint(env.manager.context, env.repository);
  const before = await sha256File(checkpoint);
  const createdClients = [];
  const ids = [
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  ];
  const service = new EvaluationService({
    ...env,
    idFactory: () => ids.shift(),
    clientFactory: (options) => {
      const client = new FakeBrainClient(options);
      createdClients.push(client);
      return client;
    },
  });
  const first = await service.evaluate({ flyId: env.fly.id, datasetPath: "fixture.json" });
  const second = await service.evaluate({ flyId: env.fly.id, datasetPath: "fixture.json" });
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(first.metrics.deterministicSummaryHash, second.metrics.deterministicSummaryHash);
  assert.equal(first.metrics.checkpointUnchanged, true);
  assert.equal(await sha256File(checkpoint), before);
  assert.ok(createdClients.flatMap((client) => client.requests).every((request) => request.learning === false));
  env.store.close();
});
