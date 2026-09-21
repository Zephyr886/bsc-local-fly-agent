import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import { FlyRepository } from "../src/flies/fly-repository.mjs";
import { createFlyRouteHandler } from "../src/http/fly-routes.mjs";
import { sendJson } from "../src/http/http.mjs";

const TOKEN = "0x1111111111111111111111111111111111111111";
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVALUATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function apiFixture() {
  const root = await mkdtemp(join(tmpdir(), "flap-fly-api-"));
  const repository = new FlyRepository({ dataRoot: join(root, "data") });
  await repository.init();
  const runs = [];
  const evaluations = [];
  const manager = {
    state: "inactive",
    context: null,
    async activate(flyId) {
      if (this.state === "running") {
        throw Object.assign(new Error("运行中不能切换"), { code: "FLY_SWITCH_WHILE_RUNNING" });
      }
      const fly = await repository.get(flyId);
      this.context = {
        flyId,
        revision: fly.currentRevision,
        profileHash: fly.profile.metadata.profileHash,
        checkpointId: fly.activeCheckpointId,
      };
      this.state = "ready";
      return this.context;
    },
    async profileUpdated(flyId) {
      if (this.context?.flyId !== flyId) return { active: false, pending: false };
      const fly = await repository.get(flyId);
      if (this.state === "running") return { active: true, pending: true };
      this.context = { ...this.context, revision: fly.currentRevision, profileHash: fly.profile.metadata.profileHash };
      return { active: true, pending: false };
    },
  };
  const trainingService = {
    list(flyId, limit = 50, offset = 0) { return runs.filter((run) => run.flyId === flyId).slice(offset, offset + limit); },
    get(id) { return runs.find((run) => run.id === id) || null; },
    async startLive({ flyId, tokenAddress }) {
      const run = { id: RUN_ID, flyId, tokenAddress, mode: "live-observation", status: "running" };
      runs.unshift(run);
      return run;
    },
    async runReplay({ flyId, datasetPath }) {
      const run = { id: RUN_ID, flyId, datasetPath, mode: "deterministic-replay", status: "completed" };
      runs.unshift(run);
      return run;
    },
    async stop(id) {
      const run = this.get(id);
      if (!run) throw Object.assign(new Error("训练轮次不存在"), { code: "TRAINING_RUN_NOT_FOUND" });
      run.status = "completed";
      return run;
    },
  };
  const evaluationService = {
    list(flyId, limit = 50, offset = 0) { return evaluations.filter((item) => item.flyId === flyId).slice(offset, offset + limit); },
    async evaluate({ flyId, datasetPath }) {
      const evaluation = { id: EVALUATION_ID, flyId, datasetPath, status: "completed" };
      evaluations.unshift(evaluation);
      return evaluation;
    },
  };
  let tokenFailure = false;
  const handler = createFlyRouteHandler({
    repository,
    manager,
    trainingService,
    evaluationService,
    resolveLiveToken: async () => {
      if (tokenFailure) throw new Error("C:\\private\\privateKey.txt password");
      return { marketMode: "live", price: 1, symbol: "TEST" };
    },
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (!await handler(request, response, url)) sendJson(response, 404, { error: "Not found" });
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const { port } = server.address();
  return {
    repository,
    manager,
    setTokenFailure(value) { tokenFailure = value; },
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}

async function request(origin, path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("Fly HTTP API covers every mutation and returns structured 201/400/404/409/423 errors", async () => {
  const env = await apiFixture();
  try {
    const schema = await request(env.origin, "/api/fly-profile/schema");
    assert.equal(schema.status, 200);
    assert.equal(schema.body.systemPolicy.listener, undefined);
    assert.equal(JSON.stringify(schema.body).includes("bindHost"), false);

    const presets = await request(env.origin, "/api/fly-profile/presets");
    assert.equal(presets.body.items.length, 4);
    assert.equal(presets.body.items[0].spec, undefined);

    const created = await request(env.origin, "/api/flies", {
      method: "POST",
      body: { name: "API fly", presetId: "balanced-v1" },
    });
    assert.equal(created.status, 201);
    const flyId = created.body.fly.id;

    const detail = await request(env.origin, `/api/flies/${flyId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.fly.currentRevision, 1);

    const invalidPatch = await request(env.origin, `/api/flies/${flyId}`, {
      method: "PATCH",
      body: { expectedRevision: 1, name: "must-not-commit", archived: "yes" },
    });
    assert.equal(invalidPatch.status, 400);
    const unchanged = await request(env.origin, `/api/flies/${flyId}`);
    assert.equal(unchanged.body.fly.currentRevision, 1);
    assert.equal(unchanged.body.fly.name, "API fly");

    const profile = await request(env.origin, `/api/flies/${flyId}/profile`, {
      method: "PUT",
      body: { expectedRevision: 1, spec: { risk: { maxBuyBnb: "0.1" } } },
    });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.revision, 2);
    assert.ok(profile.body.changedPaths.includes("/spec/risk/maxBuyBnb"));

    const revisions = await request(env.origin, `/api/flies/${flyId}/revisions`);
    assert.deepEqual(revisions.body.items.map((item) => item.revision), [2, 1]);
    const revision = await request(env.origin, `/api/flies/${flyId}/revisions/1`);
    assert.equal(revision.body.metadata.revision, 1);

    const patched = await request(env.origin, `/api/flies/${flyId}`, {
      method: "PATCH",
      body: { expectedRevision: 2, name: "Renamed API fly" },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.revision, 3);

    const rollback = await request(env.origin, `/api/flies/${flyId}/rollback`, {
      method: "POST",
      body: { expectedRevision: 3, revision: 1 },
    });
    assert.equal(rollback.status, 200);
    assert.equal(rollback.body.revision, 4);

    const clone = await request(env.origin, `/api/flies/${flyId}/clone`, {
      method: "POST",
      body: { name: "API clone", copyCheckpoint: false },
    });
    assert.equal(clone.status, 201);
    const cloneId = clone.body.fly.id;
    const archived = await request(env.origin, `/api/flies/${cloneId}`, {
      method: "PATCH",
      body: { expectedRevision: 1, archived: true },
    });
    assert.equal(archived.status, 200);
    assert.ok(archived.body.fly.archivedAt);

    const activated = await request(env.origin, `/api/flies/${flyId}/activate`, {
      method: "POST",
      body: { expectedRevision: 4 },
    });
    assert.equal(activated.status, 200);

    const training = await request(env.origin, `/api/flies/${flyId}/training-runs`, {
      method: "POST",
      body: { mode: "live-observation", tokenAddress: TOKEN },
    });
    assert.equal(training.status, 201);
    const trainingList = await request(env.origin, `/api/flies/${flyId}/training-runs?limit=10&offset=0`);
    assert.equal(trainingList.body.items.length, 1);
    assert.equal((await request(env.origin, `/api/training-runs/${RUN_ID}`)).status, 200);
    const stopped = await request(env.origin, `/api/training-runs/${RUN_ID}/stop`, {
      method: "POST", body: {},
    });
    assert.equal(stopped.status, 200);

    const evaluation = await request(env.origin, `/api/flies/${flyId}/evaluations`, {
      method: "POST", body: { datasetPath: "fixture.json" },
    });
    assert.equal(evaluation.status, 201);
    assert.equal((await request(env.origin, `/api/flies/${flyId}/evaluations`)).body.items.length, 1);

    const badProfile = await request(env.origin, `/api/flies/${flyId}/profile`, {
      method: "PUT", body: { expectedRevision: 4, spec: { risk: { maxBuyBnb: 1 } } },
    });
    assert.equal(badProfile.status, 400);
    assert.equal(badProfile.body.error.code, "PROFILE_VALIDATION_FAILED");
    assert.ok(Array.isArray(badProfile.body.error.fields));

    const conflict = await request(env.origin, `/api/flies/${flyId}/profile`, {
      method: "PUT", body: { expectedRevision: 1, spec: { risk: { maxBuyBnb: "0.1" } } },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "PROFILE_REVISION_CONFLICT");

    const missing = await request(env.origin, "/api/training-runs/cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    assert.equal(missing.status, 404);

    env.manager.state = "running";
    const locked = await request(env.origin, `/api/flies/${cloneId}/activate`, {
      method: "POST", body: { expectedRevision: 1 },
    });
    assert.equal(locked.status, 423);
    env.manager.state = "ready";

    const crossSite = await request(env.origin, "/api/flies", {
      method: "POST",
      body: { name: "blocked" },
      headers: { origin: "https://evil.example" },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.body.error.code, "SAME_ORIGIN_REQUIRED");

    const missingType = await request(env.origin, "/api/flies", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: undefined,
    });
    assert.equal(missingType.status, 400);
    assert.equal(missingType.body.error.code, "JSON_CONTENT_TYPE_REQUIRED");

    const oversized = await request(env.origin, "/api/flies", {
      method: "POST",
      body: { name: "x".repeat(33_000) },
    });
    assert.equal(oversized.status, 400);
    assert.equal(oversized.body.error.code, "REQUEST_TOO_LARGE");

    const invalidId = await request(env.origin, "/api/flies/not-a-uuid");
    assert.equal(invalidId.status, 400);
    assert.equal(invalidId.body.error.code, "INVALID_FLY_ID");

    env.setTokenFailure(true);
    const internal = await request(env.origin, `/api/flies/${flyId}/training-runs`, {
      method: "POST",
      body: { mode: "live-observation", tokenAddress: TOKEN },
    });
    assert.equal(internal.status, 500);
    const serialized = JSON.stringify(internal.body);
    assert.equal(serialized.includes("privateKey"), false);
    assert.equal(serialized.includes("password"), false);
    assert.equal(serialized.includes("C:\\"), false);
  } finally {
    await env.close();
  }
});

test("production server wiring preserves security headers and structured cross-origin errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "flap-server-api-"));
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    windowsHide: true,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      FLAP_DATA_ROOT: join(root, "data"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  const origin = await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`server startup timeout: ${stderr}`)), 10_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`server exited ${code}: ${stderr}`));
    });
    lines.on("line", (line) => {
      const match = line.match(/(http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolvePromise(match[1]);
      }
    });
  });
  try {
    const fliesPage = await fetch(`${origin}/flies`);
    assert.equal(fliesPage.status, 200);
    assert.match(fliesPage.headers.get("content-type"), /text\/html/);
    assert.match(await fliesPage.text(), /id="fly-workspace"/);
    const fliesScript = await fetch(`${origin}/flies.js`);
    assert.equal(fliesScript.status, 200);
    assert.match(fliesScript.headers.get("content-type"), /text\/javascript/);
    const schema = await fetch(`${origin}/api/fly-profile/schema`);
    assert.equal(schema.status, 200);
    assert.match(schema.headers.get("content-security-policy"), /default-src 'self'/);
    const blocked = await fetch(`${origin}/api/flies`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ name: "blocked" }),
    });
    assert.equal(blocked.status, 403);
    const body = await blocked.json();
    assert.equal(body.error.code, "SAME_ORIGIN_REQUIRED");
  } finally {
    lines.close();
    child.kill();
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  }
});
