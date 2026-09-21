import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CURRENT_SCHEMA_VERSION, migrateDatabase } from "../src/persistence/migrations.mjs";
import { SqliteStore } from "../src/persistence/sqlite-store.mjs";

const LEGACY_SQL = await readFile(new URL("./fixtures/sqlite-v1.sql", import.meta.url), "utf8");
const FLY_ID = "11111111-1111-4111-8111-111111111111";
const TRAINING_RUN_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_HASH = `sha256:${"a".repeat(64)}`;

async function tempDatabase(name = "agent.sqlite") {
  const directory = await mkdtemp(join(tmpdir(), "flap-sqlite-v2-"));
  return join(directory, name);
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all().map((row) => row.name);
}

test("empty database migrates to v2 and repeated startup is idempotent", async () => {
  const path = await tempDatabase();
  const first = new SqliteStore(path);
  assert.equal(first.schemaVersion(), CURRENT_SCHEMA_VERSION);
  assert.deepEqual(tableNames(first.db).filter((name) => !name.startsWith("sqlite_")), [
    "decisions", "evaluations", "flies", "fly_profile_revisions", "schema_meta",
    "sessions", "training_runs", "transactions",
  ]);
  first.close();

  const second = new SqliteStore(path);
  assert.equal(second.schemaVersion(), 2);
  second.close();
});

test("legacy fixture migrates without changing original rows or JSON bytes", async () => {
  const path = await tempDatabase();
  const legacy = new DatabaseSync(path);
  legacy.exec(LEGACY_SQL);
  const before = {
    sessions: legacy.prepare("SELECT COUNT(*) AS count FROM sessions").get().count,
    decisions: legacy.prepare("SELECT COUNT(*) AS count FROM decisions").get().count,
    transactions: legacy.prepare("SELECT COUNT(*) AS count FROM transactions").get().count,
    checkpoint: legacy.prepare("SELECT checkpoint_json AS value FROM sessions").get().value,
    decision: legacy.prepare("SELECT json AS value FROM decisions").get().value,
    transaction: legacy.prepare("SELECT json AS value FROM transactions").get().value,
  };
  legacy.close();

  const store = new SqliteStore(path);
  assert.equal(store.schemaVersion(), 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, before.sessions);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM decisions").get().count, before.decisions);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM transactions").get().count, before.transactions);
  assert.equal(store.db.prepare("SELECT checkpoint_json AS value FROM sessions").get().value, before.checkpoint);
  assert.equal(store.db.prepare("SELECT json AS value FROM decisions").get().value, before.decision);
  assert.equal(store.db.prepare("SELECT json AS value FROM transactions").get().value, before.transaction);

  const oldSession = store.getSession("legacy-session");
  assert.equal(oldSession.flyId, null);
  assert.equal(oldSession.profileRevision, null);
  assert.equal(oldSession.profileHash, null);
  assert.equal(oldSession.trainingRunId, null);
  assert.deepEqual(oldSession.checkpoint, JSON.parse(before.checkpoint));
  store.close();
});

test("a failed migration rolls back every v2 schema change", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(LEGACY_SQL);

  assert.throws(() => migrateDatabase(db, {
    beforeVersionCommit(version) {
      if (version === 2) throw new Error("injected migration failure");
    },
  }), /injected migration failure/);

  assert.equal(tableNames(db).includes("schema_meta"), false);
  assert.equal(tableNames(db).includes("flies"), false);
  const columns = db.prepare("PRAGMA table_info(sessions)").all().map((row) => row.name);
  assert.equal(columns.includes("fly_id"), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 1);
  db.close();
});

test("new sessions persist all four audit identifiers across cycle updates", async () => {
  const path = await tempDatabase();
  const store = new SqliteStore(path);
  const session = {
    id: "profiled-session",
    tokenAddress: "0x2222222222222222222222222222222222222222",
    startedAt: "2026-09-19T01:02:03.000Z",
    status: "running",
    flyId: FLY_ID,
    profileRevision: 7,
    profileHash: PROFILE_HASH,
    trainingRunId: TRAINING_RUN_ID,
  };
  store.commitCycle({
    session,
    checkpoint: { marker: "cycle-1" },
    decision: {
      at: "2026-09-19T01:02:13.000Z",
      actions: { hybrid: { action: "BUY", reason: "test" } },
      executions: { hybrid: { status: "simulated", action: "BUY", amount: 0.1 } },
    },
  });

  const saved = store.getSession(session.id);
  assert.equal(saved.flyId, FLY_ID);
  assert.equal(saved.profileRevision, 7);
  assert.equal(saved.profileHash, PROFILE_HASH);
  assert.equal(saved.trainingRunId, TRAINING_RUN_ID);
  assert.deepEqual(saved.checkpoint, { marker: "cycle-1" });

  store.updateSession({ ...session, status: "stopped" }, { marker: "final" });
  assert.equal(store.getSession(session.id).status, "stopped");
  assert.deepEqual(store.getSession(session.id).checkpoint, { marker: "final" });
  store.close();
});

test("audit binding cannot be partially supplied or changed after session creation", async () => {
  const path = await tempDatabase();
  const store = new SqliteStore(path);
  const base = {
    id: "bound-session",
    tokenAddress: "0x3333333333333333333333333333333333333333",
    startedAt: "2026-09-19T02:00:00.000Z",
    status: "running",
  };
  assert.throws(() => store.updateSession({ ...base, flyId: FLY_ID }, {}),
    (error) => error.code === "INCOMPLETE_AUDIT_BINDING");

  store.updateSession({
    ...base,
    flyId: FLY_ID,
    profileRevision: 1,
    profileHash: PROFILE_HASH,
    trainingRunId: TRAINING_RUN_ID,
  }, {});
  assert.throws(() => store.updateSession({
    ...base,
    flyId: FLY_ID,
    profileRevision: 2,
    profileHash: PROFILE_HASH,
    trainingRunId: TRAINING_RUN_ID,
  }, {}), (error) => error.code === "AUDIT_BINDING_CONFLICT");
  store.close();
});

test("audit queries enforce bounded pagination", async () => {
  const path = await tempDatabase();
  const store = new SqliteStore(path, { maxPageLimit: 40 });
  const insert = store.db.prepare(
    "INSERT INTO decisions(session_id,decision_at,action,block_reason,json) VALUES(?,?,?,?,?)");
  for (let index = 0; index < 75; index += 1) {
    insert.run("paged", `2026-09-19T03:${String(index).padStart(2, "0")}:00.000Z`, "HOLD", null, "{}");
  }

  assert.equal(store.recentDecisions("paged", 10).length, 10);
  assert.equal(store.recentDecisions("paged", 10, 10).length, 10);
  assert.equal(store.recentDecisions("paged", 10, 10)[0].decisionAt,
    store.recentDecisions("paged", 20)[10].decisionAt);
  assert.equal(store.recentDecisions("paged", 10_000).length, 40);
  assert.throws(() => store.recentDecisions("paged", 0),
    (error) => error.code === "INVALID_PAGINATION");
  assert.throws(() => store.recentDecisions("paged", 10, -1),
    (error) => error.code === "INVALID_PAGINATION");
  store.close();
});
