import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FlyRepository } from "../src/flies/fly-repository.mjs";

async function repository() {
  const dataRoot = await mkdtemp(join(tmpdir(), "flap-fly-repository-"));
  const repo = new FlyRepository({ dataRoot });
  await repo.init();
  return { dataRoot, repo };
}

test("create, list, get and metadata changes use immutable revisions", async () => {
  const { dataRoot, repo } = await repository();
  const created = await repo.create({ name: "Alpha", description: "first", tags: ["lab"] });

  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal(created.currentRevision, 1);
  assert.equal(created.profile.metadata.name, "Alpha");
  assert.deepEqual((await repo.list()).map((fly) => fly.id), [created.id]);

  const updated = await repo.updateMetadata(created.id, {
    expectedRevision: 1,
    name: "Alpha 2",
    description: "second",
    tags: ["lab", "v2"],
  });
  assert.equal(updated.currentRevision, 2);
  assert.equal(updated.profile.metadata.name, "Alpha 2");
  assert.deepEqual(await repo.listRevisions(created.id), [1, 2]);

  const first = JSON.parse(await readFile(join(dataRoot, "flies", created.id, "profiles", "000001.json"), "utf8"));
  assert.equal(first.metadata.name, "Alpha");
});

test("two concurrent updates with the same expected revision allow exactly one winner", async () => {
  const { repo } = await repository();
  const fly = await repo.create({ name: "Concurrent" });

  const results = await Promise.allSettled([
    repo.updateProfile(fly.id, { expectedRevision: 1, spec: { strategy: { buyPercent: 3 } } }),
    repo.updateProfile(fly.id, { expectedRevision: 1, spec: { strategy: { buyPercent: 4 } } }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "PROFILE_REVISION_CONFLICT");
  assert.equal((await repo.get(fly.id)).currentRevision, 2);
  assert.deepEqual(await repo.listRevisions(fly.id), [1, 2]);
});

test("an interrupted unique temporary write does not hide the last valid revision", async () => {
  const { dataRoot, repo } = await repository();
  const fly = await repo.create({ name: "Durable" });
  const profiles = join(dataRoot, "flies", fly.id, "profiles");
  await writeFile(join(profiles, ".000002.json.6c56ed37.tmp"), "{not-json", "utf8");

  const reopened = new FlyRepository({ dataRoot });
  const report = await reopened.init();
  assert.equal(report.readOnly, false);
  assert.equal((await reopened.get(fly.id)).currentRevision, 1);
  assert.deepEqual(await reopened.listRevisions(fly.id), [1]);
});

test("path traversal, malformed fly IDs and checkpoint IDs are rejected", async () => {
  const { repo } = await repository();
  const fly = await repo.create({ name: "Safe" });

  for (const id of ["../escape", "not-a-uuid", `${fly.id}/profiles`]) {
    await assert.rejects(repo.get(id), (error) => error.code === "INVALID_FLY_ID");
  }
  await assert.rejects(
    repo.clone(fly.id, { name: "Bad checkpoint", checkpointId: "../checkpoint", copyCheckpoint: true }),
    (error) => error.code === "INVALID_CHECKPOINT_ID",
  );
});

test("flies keep profiles, histories and checkpoint trees isolated", async () => {
  const { dataRoot, repo } = await repository();
  const alpha = await repo.create({ name: "Alpha" });
  const beta = await repo.create({ name: "Beta" });
  await repo.updateProfile(alpha.id, { expectedRevision: 1, spec: { strategy: { buyPercent: 7 } } });

  assert.equal((await repo.get(alpha.id)).profile.spec.strategy.buyPercent, 7);
  assert.equal((await repo.get(beta.id)).profile.spec.strategy.buyPercent, 2);
  assert.deepEqual(await repo.listRevisions(alpha.id), [1, 2]);
  assert.deepEqual(await repo.listRevisions(beta.id), [1]);

  const checkpointId = "11111111-1111-4111-8111-111111111111";
  const sourceCheckpoint = join(dataRoot, "flies", alpha.id, "checkpoints", checkpointId);
  await mkdir(sourceCheckpoint, { recursive: true });
  await writeFile(join(sourceCheckpoint, "service.json"), "{}", "utf8");
  await repo.setActiveCheckpoint(alpha.id, { expectedRevision: 2, checkpointId });

  const noCheckpoint = await repo.clone(alpha.id, { name: "Clone clean" });
  assert.equal(noCheckpoint.activeCheckpointId, null);

  const withCheckpoint = await repo.clone(alpha.id, { name: "Clone state", copyCheckpoint: true });
  assert.notEqual(withCheckpoint.activeCheckpointId, checkpointId);
  const provenance = JSON.parse(await readFile(join(
    dataRoot, "flies", withCheckpoint.id, "checkpoints", withCheckpoint.activeCheckpointId, "clone-source.json"), "utf8"));
  assert.deepEqual(provenance.source, { flyId: alpha.id, checkpointId });
  const clonedMetadata = JSON.parse(await readFile(join(
    dataRoot, "flies", withCheckpoint.id, "checkpoints", withCheckpoint.activeCheckpointId, "service.json"), "utf8"));
  assert.equal(clonedMetadata.flyId, withCheckpoint.id);
  assert.equal(clonedMetadata.profileRevision, 1);
  assert.equal(clonedMetadata.profileHash, withCheckpoint.profile.metadata.profileHash);
  assert.deepEqual(clonedMetadata.clonedFrom, { flyId: alpha.id, checkpointId });
});

test("rollback creates a new revision and archive is reversible metadata", async () => {
  const { repo } = await repository();
  const fly = await repo.create({ name: "History" });
  await repo.updateProfile(fly.id, { expectedRevision: 1, spec: { strategy: { buyPercent: 9 } } });

  const rolledBack = await repo.rollback(fly.id, { expectedRevision: 2, revision: 1 });
  assert.equal(rolledBack.currentRevision, 3);
  assert.equal(rolledBack.profile.spec.strategy.buyPercent, 2);
  assert.deepEqual(await repo.listRevisions(fly.id), [1, 2, 3]);

  const archived = await repo.archive(fly.id, { expectedRevision: 3, archived: true });
  assert.ok(archived.archivedAt);
  assert.equal((await repo.list()).length, 0);
  assert.equal((await repo.list({ includeArchived: true })).length, 1);
});

test("startup inconsistency enters read-only mode without guessing a repair", async () => {
  const { dataRoot, repo } = await repository();
  const fly = await repo.create({ name: "Active" });
  await writeFile(join(dataRoot, "active-fly.json"), `${JSON.stringify({
    flyId: fly.id,
    revision: 99,
    checkpointId: null,
  })}\n`, "utf8");

  const reopened = new FlyRepository({ dataRoot });
  const report = await reopened.init();
  assert.equal(report.readOnly, true);
  assert.ok(report.issues.some((issue) => issue.code === "ACTIVE_REVISION_MISMATCH"));
  assert.equal((await reopened.get(fly.id)).currentRevision, 1);
  await assert.rejects(
    reopened.updateMetadata(fly.id, { expectedRevision: 1, name: "blocked" }),
    (error) => error.code === "FLY_REPOSITORY_READ_ONLY",
  );

  const marker = JSON.parse(await readFile(join(dataRoot, "active-fly.json"), "utf8"));
  assert.equal(marker.revision, 99);
});
