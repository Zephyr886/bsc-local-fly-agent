import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class SqliteStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_decisions_session_at ON decisions(session_id, decision_at DESC);
      CREATE INDEX IF NOT EXISTS idx_transactions_session_id ON transactions(session_id, id DESC);
    `);
    this.upsertSession = this.db.prepare(`INSERT INTO sessions(id,token_address,started_at,status,checkpoint_json,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,checkpoint_json=excluded.checkpoint_json,updated_at=excluded.updated_at`);
    this.insertDecision = this.db.prepare(`INSERT OR REPLACE INTO decisions(session_id,decision_at,action,block_reason,json) VALUES(?,?,?,?,?)`);
    this.insertTransaction = this.db.prepare(`INSERT OR IGNORE INTO transactions(session_id,decision_at,model,action,amount,status,json) VALUES(?,?,?,?,?,?,?)`);
  }

  commitCycle({ session, decision, checkpoint }) {
    const at = decision.at;
    const execution = decision.executions?.hybrid;
    const hybrid = decision.actions?.hybrid || { action: "HOLD", reason: "unknown" };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.upsertSession.run(session.id, session.tokenAddress, session.startedAt, session.status, JSON.stringify(checkpoint), new Date().toISOString());
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
    this.upsertSession.run(session.id, session.tokenAddress, session.startedAt, session.status, JSON.stringify(checkpoint), new Date().toISOString());
  }

  recentTransactions(sessionId, limit = 80) {
    return this.db.prepare("SELECT id,decision_at AS decisionAt,model,action,amount,status,json FROM transactions WHERE session_id=? ORDER BY id DESC LIMIT ?")
      .all(sessionId, limit).map((row) => ({ ...row, detail: JSON.parse(row.json) }));
  }

  recentDecisions(sessionId, limit = 60) {
    return this.db.prepare("SELECT decision_at AS decisionAt,action,block_reason AS blockReason,json FROM decisions WHERE session_id=? ORDER BY decision_at DESC LIMIT ?")
      .all(sessionId, limit).map((row) => ({ ...row, detail: JSON.parse(row.json) }));
  }

  close() { this.db.close(); }
}
