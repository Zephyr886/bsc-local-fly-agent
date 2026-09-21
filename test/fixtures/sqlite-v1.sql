CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_address TEXT NOT NULL,
  started_at TEXT NOT NULL,
  status TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE decisions (
  session_id TEXT NOT NULL,
  decision_at TEXT NOT NULL,
  action TEXT NOT NULL,
  block_reason TEXT,
  json TEXT NOT NULL,
  PRIMARY KEY (session_id, decision_at)
);
CREATE TABLE transactions (
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
CREATE INDEX idx_decisions_session_at ON decisions(session_id, decision_at DESC);
CREATE INDEX idx_transactions_session_id ON transactions(session_id, id DESC);

INSERT INTO sessions VALUES (
  'legacy-session',
  '0x1111111111111111111111111111111111111111',
  '2026-01-02T03:04:05.000Z',
  'stopped',
  '{"accounts":{"hybrid":{"bnb":1}},"raw":"keep exactly"}',
  '2026-01-02T03:05:05.000Z'
);
INSERT INTO decisions VALUES (
  'legacy-session',
  '2026-01-02T03:04:35.000Z',
  'HOLD',
  'fixture',
  '{"at":"2026-01-02T03:04:35.000Z","nested":{"a":1,"b":[2,3]}}'
);
INSERT INTO transactions(session_id,decision_at,model,action,amount,status,json) VALUES (
  'legacy-session',
  '2026-01-02T03:04:35.000Z',
  'hybrid',
  'BUY',
  0.125,
  'simulated',
  '{"status":"simulated","amount":"0.125","note":"unchanged"}'
);
