export const CURRENT_SCHEMA_VERSION = 2;

const LEGACY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    token_address TEXT NOT NULL,
    started_at TEXT NOT NULL,
    status TEXT NOT NULL,
    checkpoint_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS decisions (
    session_id TEXT NOT NULL,
    decision_at TEXT NOT NULL,
    action TEXT NOT NULL,
    block_reason TEXT,
    json TEXT NOT NULL,
    PRIMARY KEY (session_id, decision_at)
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    decision_at TEXT NOT NULL,
    model TEXT NOT NULL,
    action TEXT NOT NULL,
    amount REAL NOT NULL,
    status TEXT NOT NULL,
    json TEXT NOT NULL,
    UNIQUE(session_id, decision_at, model)
  );
  CREATE INDEX IF NOT EXISTS idx_decisions_session_at
    ON decisions(session_id, decision_at DESC);
  CREATE INDEX IF NOT EXISTS idx_transactions_session_id
    ON transactions(session_id, id DESC);
`;

const V2_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS flies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    current_revision INTEGER NOT NULL,
    active_checkpoint_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );
  CREATE TABLE IF NOT EXISTS fly_profile_revisions (
    fly_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    profile_hash TEXT NOT NULL,
    document_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (fly_id, revision),
    UNIQUE (fly_id, profile_hash, revision)
  );
  CREATE TABLE IF NOT EXISTS training_runs (
    id TEXT PRIMARY KEY,
    fly_id TEXT NOT NULL,
    profile_revision INTEGER NOT NULL,
    profile_hash TEXT NOT NULL,
    token_address TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    stopped_at TEXT,
    checkpoint_before TEXT,
    checkpoint_after TEXT,
    summary_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS evaluations (
    id TEXT PRIMARY KEY,
    fly_id TEXT NOT NULL,
    profile_revision INTEGER NOT NULL,
    checkpoint_id TEXT,
    dataset_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_flies_updated_at
    ON flies(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_profile_revisions_hash
    ON fly_profile_revisions(fly_id, profile_hash);
  CREATE INDEX IF NOT EXISTS idx_training_runs_fly_started
    ON training_runs(fly_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_training_runs_status
    ON training_runs(status, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_evaluations_fly_created
    ON evaluations(fly_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_fly_started
    ON sessions(fly_id, started_at DESC);
`;

function tableExists(db, name) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(name));
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function addColumn(db, table, definition) {
  const name = definition.split(/\s+/, 1)[0];
  if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function detectedVersion(db) {
  if (!tableExists(db, "schema_meta")) return tableExists(db, "sessions") ? 1 : 0;
  const rows = db.prepare("SELECT version FROM schema_meta").all();
  if (rows.length !== 1 || !Number.isSafeInteger(rows[0].version) || rows[0].version < 1) {
    throw new Error("schema_meta 必须且只能包含一个有效版本号");
  }
  return rows[0].version;
}

function assertV2(db) {
  const requiredColumns = {
    schema_meta: ["version"],
    sessions: ["id", "token_address", "started_at", "status", "checkpoint_json", "updated_at",
      "fly_id", "profile_revision", "profile_hash", "training_run_id"],
    decisions: ["session_id", "decision_at", "action", "block_reason", "json"],
    transactions: ["id", "session_id", "decision_at", "model", "action", "amount", "status", "json"],
    flies: ["id", "name", "current_revision", "active_checkpoint_id", "created_at", "updated_at", "archived_at"],
    fly_profile_revisions: ["fly_id", "revision", "profile_hash", "document_json", "created_at"],
    training_runs: ["id", "fly_id", "profile_revision", "profile_hash", "token_address", "mode", "status",
      "started_at", "stopped_at", "checkpoint_before", "checkpoint_after", "summary_json"],
    evaluations: ["id", "fly_id", "profile_revision", "checkpoint_id", "dataset_hash", "status", "metrics_json", "created_at"],
  };
  for (const [table, names] of Object.entries(requiredColumns)) {
    if (!tableExists(db, table)) throw new Error(`SQLite schema v2 缺少表：${table}`);
    const actual = columns(db, table);
    for (const name of names) {
      if (!actual.has(name)) throw new Error(`SQLite schema v2 ${table} 缺少列：${name}`);
    }
  }
}

export function migrateDatabase(db, { beforeVersionCommit = () => {} } = {}) {
  const fromVersion = detectedVersion(db);
  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`SQLite schema ${fromVersion} 高于本程序支持的 ${CURRENT_SCHEMA_VERSION}`);
  }
  if (fromVersion === CURRENT_SCHEMA_VERSION) {
    assertV2(db);
    return { fromVersion, toVersion: CURRENT_SCHEMA_VERSION, migrated: false };
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(LEGACY_SCHEMA_SQL);
    db.exec("CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL)");
    addColumn(db, "sessions", "fly_id TEXT");
    addColumn(db, "sessions", "profile_revision INTEGER");
    addColumn(db, "sessions", "profile_hash TEXT");
    addColumn(db, "sessions", "training_run_id TEXT");
    db.exec(V2_SCHEMA_SQL);
    beforeVersionCommit(CURRENT_SCHEMA_VERSION, db);
    db.exec("DELETE FROM schema_meta");
    db.prepare("INSERT INTO schema_meta(version) VALUES(?)").run(CURRENT_SCHEMA_VERSION);
    assertV2(db);
    db.exec("COMMIT");
    return { fromVersion, toVersion: CURRENT_SCHEMA_VERSION, migrated: true };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
