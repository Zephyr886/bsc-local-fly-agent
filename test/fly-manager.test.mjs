import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { FlyManager } from "../src/flies/fly-manager.mjs";
import { FlyRepository } from "../src/flies/fly-repository.mjs";
import { assertEffectiveProfile } from "../src/profile/index.mjs";

class FakeSimulation {
  constructor(events = []) {
    this.events = events;
    this.state = { status: "idle" };
    this.startCalls = 0;
  }

  async start(options) {
    this.events.push("simulation:start");
    this.startCalls += 1;
    this.options = options;
    this.state.status = "running";
    return { status: "running" };
  }

  stop() {
    this.events.push("simulation:stop");
    this.state.status = "stopped";
    return { status: "stopped" };
  }
}

class FakeBrain {
  constructor(checkpoint = resolve("initial-service.npz"), events = []) {
    this.checkpoint = checkpoint;
    this.events = events;
    this.parkGate = null;
    this.failPath = null;
  }

  async park() {
    this.events.push("brain:park:start");
    if (this.parkGate) await this.parkGate;
    this.events.push("brain:park:end");
  }

  activateCheckpoint(path) {
    const normalized = resolve(path);
    this.events.push(`brain:activate:${normalized}`);
    if (normalized === this.failPath) throw new Error("injected checkpoint activation failure");
    this.checkpoint = normalized;
  }
}

async function setup() {
  const dataRoot = await mkdtemp(join(tmpdir(), "flap-fly-manager-"));
  const repository = new FlyRepository({ dataRoot });
  await repository.init();
  const events = [];
  const brainClient = new FakeBrain(resolve(join(dataRoot, "legacy.npz")), events);
  const simulation = new FakeSimulation(events);
  const deck = { active: null, runCheckpoint() { throw new Error("no active v3 run"); } };
  return { dataRoot, repository, events, brainClient, simulation, deck };
}

async function createFlyWithCheckpoint(repository, dataRoot, name, checkpointId) {
  const fly = await repository.create({ name });
  const directory = join(dataRoot, "flies", fly.id, "checkpoints", checkpointId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "service.npz"), `checkpoint:${name}`, "utf8");
  await writeFile(join(directory, "service.json"), "{}", "utf8");
  return repository.setActiveCheckpoint(fly.id, { expectedRevision: 1, checkpointId });
}

test("activation freezes the current revision into a ready context", async () => {
  const environment = await setup();
  const fly = await createFlyWithCheckpoint(environment.repository, environment.dataRoot,
    "Alpha", "11111111-1111-4111-8111-111111111111");
  const manager = new FlyManager(environment);
  await manager.init();

  const context = await manager.activate(fly.id);
  assert.equal(manager.state, "ready");
  assert.equal(context.flyId, fly.id);
  assert.equal(context.revision, 1);
  assert.ok(Object.isFrozen(context));
  assertEffectiveProfile(context.effectiveProfile);
  assert.equal(environment.brainClient.checkpoint, resolve(join(
    environment.dataRoot, "flies", fly.id, "checkpoints", fly.activeCheckpointId, "service.npz")));

  const marker = JSON.parse(await readFile(join(environment.dataRoot, "active-fly.json"), "utf8"));
  assert.deepEqual(marker, { flyId: fly.id, revision: 1, checkpointId: fly.activeCheckpointId });
});

test("direct switching while running is rejected", async () => {
  const environment = await setup();
  const alpha = await createFlyWithCheckpoint(environment.repository, environment.dataRoot,
    "Alpha", "11111111-1111-4111-8111-111111111111");
  const beta = await createFlyWithCheckpoint(environment.repository, environment.dataRoot,
    "Beta", "22222222-2222-4222-8222-222222222222");
  const manager = new FlyManager(environment);
  await manager.init();
  await manager.activate(alpha.id);
  await manager.start({ tokenAddress: "0x1111111111111111111111111111111111111111" });

  await assert.rejects(manager.switchTo(beta.id), (error) => error.code === "FLY_SWITCH_WHILE_RUNNING");
  assert.equal(manager.state, "running");
  assert.equal(manager.context.flyId, alpha.id);
});

test("an active Profile update advances the marker immediately and applies after the running session stops", async () => {
  const environment = await setup();
  const fly = await createFlyWithCheckpoint(environment.repository, environment.dataRoot,
    "Profile update", "11111111-1111-4111-8111-111111111111");
  const manager = new FlyManager(environment);
  await manager.init();
  await manager.activate(fly.id);
  await manager.start({ tokenAddress: "0x1111111111111111111111111111111111111111" });

  const updated = await environment.repository.updateProfile(fly.id, {
    expectedRevision: 1,
    spec: { risk: { maxBuyBnb: "0.1" } },
  });
  const activation = await manager.profileUpdated(fly.id);
  assert.equal(activation.pending, true);
  assert.equal(manager.context.revision, 1);
  assert.equal(manager.snapshot().pendingProfile.revision, 2);
  const marker = JSON.parse(await readFile(join(environment.dataRoot, "active-fly.json"), "utf8"));
  assert.equal(marker.revision, 2);
  assert.equal(marker.checkpointId, updated.activeCheckpointId);

  await manager.stop();
  assert.equal(manager.context.revision, 2);
  assert.equal(manager.context.profileHash, updated.profile.metadata.profileHash);
  assert.equal(manager.snapshot().pendingProfile, null);
});

test("switch waits for a pending neural request before marker and checkpoint change", async () => {
  const environment = await setup();
  const alpha = await createFlyWithCheckpoint(environment.repository, environment.dataRoot,
    "Alpha", "11111111-1111-4111-8111-111111111111");
  const beta = await createFlyWithCheckpoint(environment.repository, environment.dataRoot,
    "Beta", "22222222-2222-4222-8222-222222222222");
  const manager = new FlyManager(environment);
  await manager.init();
  await manager.activate(alpha.id);

  let release;
  environment.brainClient.parkGate = new Promise((resolveGate) => { release = resolveGate; });
  const switching = manager.switchTo(beta.id);
  await new Promise((resolveTick) => setImmediate(resolveTick));

  assert.equal(manager.state, "switching");
  assert.equal(manager.context.flyId, alpha.id);
  assert.equal(environment.brainClient.checkpoint, manager.context.checkpointPath);
  assert.equal(JSON.parse(await readFile(join(environment.dataRoot, "active-fly.json"), "utf8")).flyId,
    alpha.id);

  release();
  await switching;
  assert.equal(manager.state, "ready");
  assert.equal(manager.context.flyId, beta.id);
  assert.deepEqual(environment.events.slice(-3), [
    "brain:park:start",
    "brain:park:end",
    `brain:activate:${manager.context.checkpointPath}`,
  ]);
});

test("checkpoint activation failure restores old marker, context and checkpoint", async () => {
  const environment = await setup();
  const alpha = await createFlyWithCheckpoint(environment.repository, environment.dataRoot,
    "Alpha", "11111111-1111-4111-8111-111111111111");
  const beta = await createFlyWithCheckpoint(environment.repository, environment.dataRoot,
    "Beta", "22222222-2222-4222-8222-222222222222");
  const manager = new FlyManager(environment);
  await manager.init();
  const oldContext = await manager.activate(alpha.id);
  environment.brainClient.failPath = resolve(join(
    environment.dataRoot, "flies", beta.id, "checkpoints", beta.activeCheckpointId, "service.npz"));

  await assert.rejects(manager.switchTo(beta.id), /injected checkpoint activation failure/);
  assert.equal(manager.state, "ready");
  assert.equal(manager.context, oldContext);
  assert.equal(environment.brainClient.checkpoint, oldContext.checkpointPath);
  const marker = JSON.parse(await readFile(join(environment.dataRoot, "active-fly.json"), "utf8"));
  assert.equal(marker.flyId, alpha.id);
  assert.equal(marker.checkpointId, alpha.activeCheckpointId);
});

test("startup restores only active selection and never resumes a session", async () => {
  const environment = await setup();
  const fly = await createFlyWithCheckpoint(environment.repository, environment.dataRoot,
    "Remembered", "11111111-1111-4111-8111-111111111111");
  await environment.repository.writeActiveMarker({
    flyId: fly.id, revision: fly.currentRevision, checkpointId: fly.activeCheckpointId,
  });
  const manager = new FlyManager(environment);

  const snapshot = await manager.init();
  assert.equal(snapshot.state, "ready");
  assert.equal(manager.context.flyId, fly.id);
  assert.equal(environment.simulation.startCalls, 0);
  assert.notEqual(environment.simulation.state.status, "running");
});

test("first upgrade creates legacy-default only when legacy checkpoint exists", async () => {
  const environment = await setup();
  const legacyCheckpoint = join(environment.dataRoot, "full-brain", "service.npz");
  await mkdir(join(environment.dataRoot, "full-brain"), { recursive: true });
  await writeFile(legacyCheckpoint, "legacy-checkpoint-bytes", "utf8");
  await writeFile(legacyCheckpoint.replace(/\.npz$/, ".json"), "{\"legacy\":true}", "utf8");
  const manager = new FlyManager({ ...environment, legacyCheckpoint });

  await manager.init();
  const flies = await environment.repository.list();
  assert.equal(flies.length, 1);
  assert.equal(flies[0].name, "legacy-default");
  assert.equal(manager.context.flyId, flies[0].id);
  assert.equal(await readFile(legacyCheckpoint, "utf8"), "legacy-checkpoint-bytes");
  assert.equal(await readFile(manager.context.checkpointPath, "utf8"), "legacy-checkpoint-bytes");
  const migratedMetadata = JSON.parse(await readFile(
    manager.context.checkpointPath.replace(/\.npz$/, ".json"), "utf8"));
  assert.equal(migratedMetadata.flyId, flies[0].id);
  assert.equal(migratedMetadata.profileRevision, 1);
  assert.equal(migratedMetadata.profileHash, flies[0].profile.metadata.profileHash);
  assert.equal(migratedMetadata.modelVersion, "malecns-v1");
  assert.equal(migratedMetadata.migratedFromLegacy, true);
  const provenance = JSON.parse(await readFile(join(
    environment.dataRoot, "flies", flies[0].id, "checkpoints", flies[0].activeCheckpointId,
    "migration-source.json"), "utf8"));
  assert.equal(provenance.kind, "legacy-default");
});

test("no legacy fly is invented for a clean install without legacy state", async () => {
  const environment = await setup();
  const manager = new FlyManager({
    ...environment,
    legacyCheckpoint: join(environment.dataRoot, "missing", "service.npz"),
  });

  const snapshot = await manager.init();
  assert.equal(snapshot.state, "inactive");
  assert.equal((await environment.repository.list()).length, 0);
});

test("an active v3 run is preferred as the legacy migration source", async () => {
  const environment = await setup();
  const runId = "33333333-3333-4333-8333-333333333333";
  const v3Checkpoint = join(environment.dataRoot, "cartridge-console", "runs", runId, "service.npz");
  await mkdir(dirname(v3Checkpoint), { recursive: true });
  await writeFile(v3Checkpoint, "active-v3-checkpoint", "utf8");
  environment.deck.active = { id: runId };
  environment.deck.runCheckpoint = () => v3Checkpoint;
  const manager = new FlyManager({
    ...environment,
    legacyCheckpoint: join(environment.dataRoot, "missing", "service.npz"),
  });

  await manager.init();
  assert.equal((await environment.repository.list()).length, 1);
  assert.equal(await readFile(manager.context.checkpointPath, "utf8"), "active-v3-checkpoint");
});
