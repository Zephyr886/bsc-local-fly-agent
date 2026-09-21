import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CURRENT_SCHEMA_VERSION, migrateDatabase } from "./migrations.mjs";

const AUDIT_KEYS = ["flyId", "profileRevision", "profileHash", "trainingRunId"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROFILE_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TRAINING_MODES = new Set(["live-observation", "deterministic-replay"]);
const TRAINING_STATUSES = new Set(["running", "completed", "failed", "interrupted"]);
const EVALUATION_STATUSES = new Set(["running", "completed", "failed"]);

class SqliteStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SqliteStoreError";
    this.code = code;
  }
}

function auditBinding(session) {
  const present = AUDIT_KEYS.filter((key) => session[key] !== undefined && session[key] !== null);
  if (present.length === 0) return null;
  if (present.length !== AUDIT_KEYS.length) {
    throw new SqliteStoreError("INCOMPLETE_AUDIT_BINDING", "新 session 必须同时提供 flyId、profileRevision、profileHash 和 trainingRunId");
  }
  if (!UUID_PATTERN.test(session.flyId)
      || !Number.isSafeInteger(session.profileRevision) || session.profileRevision < 1
      || !PROFILE_HASH_PATTERN.test(session.profileHash)
      || !UUID_PATTERN.test(session.trainingRunId)) {
    throw new SqliteStoreError("INVALID_AUDIT_BINDING", "Session 审计绑定格式无效");
  }
  return {
    flyId: session.flyId,
    profileRevision: session.profileRevision,
    profileHash: session.profileHash,
    trainingRunId: session.trainingRunId,
  };
}

function rowBinding(row) {
  if (!row || row.flyId === null) return null;
  return Object.fromEntries(AUDIT_KEYS.map((key) => [key, row[key]]));
}

function sameBinding(left, right) {
  return AUDIT_KEYS.every((key) => left[key] === right[key]);
}

function parsePage(limit, offset, maxPageLimit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new SqliteStoreError("INVALID_PAGINATION", "limit 必须为正整数，offset 必须为非负整数");
  }
  return { limit: Math.min(limit, maxPageLimit), offset };
}

function mapSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    tokenAddress: row.tokenAddress,
    startedAt: row.startedAt,
    status: row.status,
    checkpoint: JSON.parse(row.checkpointJson),
    updatedAt: row.updatedAt,
    flyId: row.flyId,
    profileRevision: row.profileRevision,
    profileHash: row.profileHash,
    trainingRunId: row.trainingRunId,
  };
}

function parseJson(value, fallback = null) {
  return typeof value === "string" ? JSON.parse(value) : fallback;
}

function mapTrainingRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    flyId: row.flyId,
    profileRevision: row.profileRevision,
    profileHash: row.profileHash,
    tokenAddress: row.tokenAddress,
    mode: row.mode,
    status: row.status,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt,
    checkpointBefore: parseJson(row.checkpointBefore),
    checkpointAfter: parseJson(row.checkpointAfter),
    summary: parseJson(row.summaryJson, {}),
  };
}

function mapEvaluation(row) {
  if (!row) return null;
  return {
    id: row.id,
    flyId: row.flyId,
    profileRevision: row.profileRevision,
    checkpointId: row.checkpointId,
    datasetHash: row.datasetHash,
    status: row.status,
    metrics: parseJson(row.metricsJson, {}),
    createdAt: row.createdAt,
  };
}

function assertUuid(value, label) {
  if (!UUID_PATTERN.test(value)) throw new SqliteStoreError("INVALID_ID", `${label} 必须是 UUID`);
}

export class SqliteStore {
  constructor(path, { maxPageLimit = 200 } = {}) {
    if (!Number.isSafeInteger(maxPageLimit) || maxPageLimit < 1 || maxPageLimit > 1000) {
      throw new TypeError("maxPageLimit 必须是 1 到 1000 的整数");
    }
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.maxPageLimit = maxPageLimit;
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");
      migrateDatabase(this.db);
      this.upsertSession = this.db.prepare(`
        INSERT INTO sessions(
          id,token_address,started_at,status,checkpoint_json,updated_at,
          fly_id,profile_revision,profile_hash,training_run_id
        ) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          status=excluded.status,
          checkpoint_json=excluded.checkpoint_json,
          updated_at=excluded.updated_at
      `);
      this.selectSessionBinding = this.db.prepare(`
        SELECT
          fly_id AS flyId,
          profile_revision AS profileRevision,
          profile_hash AS profileHash,
          training_run_id AS trainingRunId
        FROM sessions WHERE id=?
      `);
      this.selectSession = this.db.prepare(`
        SELECT
          id, token_address AS tokenAddress, started_at AS startedAt, status,
          checkpoint_json AS checkpointJson, updated_at AS updatedAt,
          fly_id AS flyId, profile_revision AS profileRevision,
          profile_hash AS profileHash, training_run_id AS trainingRunId
        FROM sessions WHERE id=?
      `);
      this.insertDecision = this.db.prepare(
        "INSERT OR REPLACE INTO decisions(session_id,decision_at,action,block_reason,json) VALUES(?,?,?,?,?)");
      this.insertTransaction = this.db.prepare(
        "INSERT OR IGNORE INTO transactions(session_id,decision_at,model,action,amount,status,json) VALUES(?,?,?,?,?,?,?)");
      this.insertTrainingRun = this.db.prepare(`
        INSERT INTO training_runs(
          id,fly_id,profile_revision,profile_hash,token_address,mode,status,
          started_at,stopped_at,checkpoint_before,checkpoint_after,summary_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      this.selectTrainingRun = this.db.prepare(`
        SELECT id,fly_id AS flyId,profile_revision AS profileRevision,profile_hash AS profileHash,
          token_address AS tokenAddress,mode,status,started_at AS startedAt,stopped_at AS stoppedAt,
          checkpoint_before AS checkpointBefore,checkpoint_after AS checkpointAfter,summary_json AS summaryJson
        FROM training_runs WHERE id=?
      `);
      this.updateTrainingRunState = this.db.prepare(`
        UPDATE training_runs SET status=?,stopped_at=?,checkpoint_after=?,summary_json=? WHERE id=?
      `);
      this.insertEvaluation = this.db.prepare(`
        INSERT INTO evaluations(
          id,fly_id,profile_revision,checkpoint_id,dataset_hash,status,metrics_json,created_at
        ) VALUES(?,?,?,?,?,?,?,?)
      `);
      this.selectEvaluation = this.db.prepare(`
        SELECT id,fly_id AS flyId,profile_revision AS profileRevision,checkpoint_id AS checkpointId,
          dataset_hash AS datasetHash,status,metrics_json AS metricsJson,created_at AS createdAt
        FROM evaluations WHERE id=?
      `);
      this.updateEvaluationState = this.db.prepare(
        "UPDATE evaluations SET status=?,metrics_json=? WHERE id=?");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  schemaVersion() {
    return this.db.prepare("SELECT version FROM schema_meta").get().version;
  }

  #writeSession(session, checkpoint) {
    const supplied = auditBinding(session);
    const existingRow = this.selectSessionBinding.get(session.id);
    const existing = rowBinding(existingRow);
    if (existing && supplied && !sameBinding(existing, supplied)) {
      throw new SqliteStoreError("AUDIT_BINDING_CONFLICT", "已创建 session 的审计绑定不可更改");
    }
    if (existingRow && !existing && supplied) {
      throw new SqliteStoreError("AUDIT_BINDING_CONFLICT", "Legacy session 不允许事后绑定到 Profile");
    }
    const binding = supplied || existing;
    this.upsertSession.run(
      session.id,
      session.tokenAddress,
      session.startedAt,
      session.status,
      JSON.stringify(checkpoint),
      new Date().toISOString(),
      binding?.flyId ?? null,
      binding?.profileRevision ?? null,
      binding?.profileHash ?? null,
      binding?.trainingRunId ?? null,
    );
  }

  commitCycle({ session, decision, checkpoint }) {
    const at = decision.at;
    const execution = decision.executions?.hybrid;
    const hybrid = decision.actions?.hybrid || { action: "HOLD", reason: "unknown" };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.#writeSession(session, checkpoint);
      this.insertDecision.run(session.id, at, hybrid.action, hybrid.reason || execution?.reason || null, JSON.stringify(decision));
      if (execution?.status === "simulated") {
        this.insertTransaction.run(session.id, at, "hybrid", execution.action, Number(execution.amount || 0), execution.status, JSON.stringify(execution));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateSession(session, checkpoint) {
    this.#writeSession(session, checkpoint);
  }

  getSession(sessionId) {
    return mapSession(this.selectSession.get(sessionId));
  }

  listSessions(limit = 50, offset = 0) {
    const page = parsePage(limit, offset, this.maxPageLimit);
    return this.db.prepare(`
      SELECT
        id, token_address AS tokenAddress, started_at AS startedAt, status,
        checkpoint_json AS checkpointJson, updated_at AS updatedAt,
        fly_id AS flyId, profile_revision AS profileRevision,
        profile_hash AS profileHash, training_run_id AS trainingRunId
      FROM sessions ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(page.limit, page.offset).map(mapSession);
  }

  recentTransactions(sessionId, limit = 80, offset = 0) {
    const page = parsePage(limit, offset, this.maxPageLimit);
    return this.db.prepare(`
      SELECT id,decision_at AS decisionAt,model,action,amount,status,json
      FROM transactions WHERE session_id=? ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(sessionId, page.limit, page.offset)
      .map((row) => ({ ...row, detail: JSON.parse(row.json) }));
  }

  recentDecisions(sessionId, limit = 60, offset = 0) {
    const page = parsePage(limit, offset, this.maxPageLimit);
    return this.db.prepare(`
      SELECT decision_at AS decisionAt,action,block_reason AS blockReason,json
      FROM decisions WHERE session_id=? ORDER BY decision_at DESC LIMIT ? OFFSET ?
    `).all(sessionId, page.limit, page.offset)
      .map((row) => ({ ...row, detail: JSON.parse(row.json) }));
  }

  createTrainingRun(run) {
    assertUuid(run.id, "trainingRunId");
    assertUuid(run.flyId, "flyId");
    if (!Number.isSafeInteger(run.profileRevision) || run.profileRevision < 1
        || !PROFILE_HASH_PATTERN.test(run.profileHash)
        || typeof run.tokenAddress !== "string"
        || !TRAINING_MODES.has(run.mode) || run.status !== "running") {
      throw new SqliteStoreError("INVALID_TRAINING_RUN", "训练轮次身份或初始状态无效");
    }
    this.insertTrainingRun.run(
      run.id, run.flyId, run.profileRevision, run.profileHash, run.tokenAddress.toLowerCase(),
      run.mode, run.status, run.startedAt, null,
      JSON.stringify(run.checkpointBefore ?? null), null, JSON.stringify(run.summary ?? {}),
    );
    return this.getTrainingRun(run.id);
  }

  getTrainingRun(runId) {
    assertUuid(runId, "trainingRunId");
    return mapTrainingRun(this.selectTrainingRun.get(runId));
  }

  listTrainingRuns(flyId, limit = 50, offset = 0) {
    assertUuid(flyId, "flyId");
    const page = parsePage(limit, offset, this.maxPageLimit);
    return this.db.prepare(`
      SELECT id,fly_id AS flyId,profile_revision AS profileRevision,profile_hash AS profileHash,
        token_address AS tokenAddress,mode,status,started_at AS startedAt,stopped_at AS stoppedAt,
        checkpoint_before AS checkpointBefore,checkpoint_after AS checkpointAfter,summary_json AS summaryJson
      FROM training_runs WHERE fly_id=? ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?
    `).all(flyId, page.limit, page.offset).map(mapTrainingRun);
  }

  runningTrainingRuns() {
    return this.db.prepare(`
      SELECT id,fly_id AS flyId,profile_revision AS profileRevision,profile_hash AS profileHash,
        token_address AS tokenAddress,mode,status,started_at AS startedAt,stopped_at AS stoppedAt,
        checkpoint_before AS checkpointBefore,checkpoint_after AS checkpointAfter,summary_json AS summaryJson
      FROM training_runs WHERE status='running' ORDER BY started_at,id
    `).all().map(mapTrainingRun);
  }

  finishTrainingRun(runId, { status, stoppedAt, checkpointAfter = null, summary = {} } = {}) {
    assertUuid(runId, "trainingRunId");
    if (!TRAINING_STATUSES.has(status) || status === "running" || typeof stoppedAt !== "string") {
      throw new SqliteStoreError("INVALID_TRAINING_RUN_STATE", "训练轮次终态无效");
    }
    const result = this.updateTrainingRunState.run(
      status, stoppedAt, JSON.stringify(checkpointAfter), JSON.stringify(summary), runId,
    );
    if (result.changes !== 1) throw new SqliteStoreError("TRAINING_RUN_NOT_FOUND", "训练轮次不存在");
    return this.getTrainingRun(runId);
  }

  createEvaluation(evaluation) {
    assertUuid(evaluation.id, "evaluationId");
    assertUuid(evaluation.flyId, "flyId");
    if (!Number.isSafeInteger(evaluation.profileRevision) || evaluation.profileRevision < 1
        || (evaluation.checkpointId !== null && !UUID_PATTERN.test(evaluation.checkpointId))
        || typeof evaluation.datasetHash !== "string" || evaluation.status !== "running") {
      throw new SqliteStoreError("INVALID_EVALUATION", "评估身份或初始状态无效");
    }
    this.insertEvaluation.run(
      evaluation.id, evaluation.flyId, evaluation.profileRevision, evaluation.checkpointId,
      evaluation.datasetHash, evaluation.status, JSON.stringify(evaluation.metrics ?? {}), evaluation.createdAt,
    );
    return this.getEvaluation(evaluation.id);
  }

  getEvaluation(evaluationId) {
    assertUuid(evaluationId, "evaluationId");
    return mapEvaluation(this.selectEvaluation.get(evaluationId));
  }

  listEvaluations(flyId, limit = 50, offset = 0) {
    assertUuid(flyId, "flyId");
    const page = parsePage(limit, offset, this.maxPageLimit);
    return this.db.prepare(`
      SELECT id,fly_id AS flyId,profile_revision AS profileRevision,checkpoint_id AS checkpointId,
        dataset_hash AS datasetHash,status,metrics_json AS metricsJson,created_at AS createdAt
      FROM evaluations WHERE fly_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?
    `).all(flyId, page.limit, page.offset).map(mapEvaluation);
  }

  runningEvaluations() {
    return this.db.prepare(`
      SELECT id,fly_id AS flyId,profile_revision AS profileRevision,checkpoint_id AS checkpointId,
        dataset_hash AS datasetHash,status,metrics_json AS metricsJson,created_at AS createdAt
      FROM evaluations WHERE status='running' ORDER BY created_at,id
    `).all().map(mapEvaluation);
  }

  finishEvaluation(evaluationId, { status, metrics = {} } = {}) {
    assertUuid(evaluationId, "evaluationId");
    if (!EVALUATION_STATUSES.has(status) || status === "running") {
      throw new SqliteStoreError("INVALID_EVALUATION_STATE", "评估终态无效");
    }
    const result = this.updateEvaluationState.run(status, JSON.stringify(metrics), evaluationId);
    if (result.changes !== 1) throw new SqliteStoreError("EVALUATION_NOT_FOUND", "评估不存在");
    return this.getEvaluation(evaluationId);
  }

  close() {
    this.db.close();
  }
}

export { CURRENT_SCHEMA_VERSION, SqliteStoreError };
