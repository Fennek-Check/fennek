CREATE TABLE IF NOT EXISTS digs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scout TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  quality TEXT NOT NULL DEFAULT 'verified',
  summary TEXT NOT NULL DEFAULT '',
  matched_count INTEGER NOT NULL DEFAULT 0,
  unmatched_count INTEGER NOT NULL DEFAULT 0,
  failed_probes INTEGER NOT NULL DEFAULT 0,
  source_tag TEXT NOT NULL DEFAULT 'house',
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_digs_started ON digs (id DESC);
CREATE INDEX IF NOT EXISTS idx_digs_scout ON digs (scout, id DESC);

CREATE TABLE IF NOT EXISTS dig_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dig_id INTEGER NOT NULL,
  step_no INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tool_name TEXT NOT NULL DEFAULT '',
  why TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 1,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_steps_dig ON dig_steps (dig_id, step_no ASC);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dig_id INTEGER NOT NULL,
  scout TEXT NOT NULL,
  claim TEXT NOT NULL,
  evidence_quote TEXT NOT NULL,
  cited_step INTEGER NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  entities_json TEXT NOT NULL DEFAULT '[]',
  verified INTEGER NOT NULL DEFAULT 1,
  verify_note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_id ON findings (id DESC);
CREATE INDEX IF NOT EXISTS idx_findings_verified ON findings (verified, id DESC);
CREATE INDEX IF NOT EXISTS idx_findings_dig ON findings (dig_id, id ASC);

CREATE TABLE IF NOT EXISTS http_cache (
  cache_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  cached_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_keys (
  api_key TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT 'agent',
  cached_tier TEXT NOT NULL DEFAULT 'free',
  cached_balance REAL NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_counters (
  actor_key TEXT NOT NULL,
  day_key TEXT NOT NULL,
  digs_used INTEGER NOT NULL DEFAULT 0,
  chats_used INTEGER NOT NULL DEFAULT 0,
  mcp_used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (actor_key, day_key)
);
