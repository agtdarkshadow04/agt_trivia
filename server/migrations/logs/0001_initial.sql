-- LOG-1: the log store, a SQLite file of its own (storage.logDatabaseFile)
-- that backups and restores never touch (LOG-17). Log tables are append-only
-- and exempt from DATA-8 (LOG-2). `seq` only grows: lists are ordered by it,
-- newest first, and cursors name it (API-8).

-- The IP-hash key and the server-log "seen" marker (LOG-12, LOG-21).
CREATE TABLE log_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;

-- LOG-7: events the server caused itself.
CREATE TABLE server_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error', 'fatal')),
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  request_id TEXT,
  details TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details))
) STRICT;
CREATE INDEX server_log_at ON server_log (at);
CREATE INDEX server_log_level ON server_log (level, seq);
CREATE INDEX server_log_source ON server_log (source, seq);

-- LOG-10: events a user caused.
CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'anonymous')),
  actor TEXT,
  ip_hash TEXT,
  client TEXT NOT NULL CHECK (client IN ('web', 'api')),
  action TEXT NOT NULL,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'rate_limited', 'failure')),
  status_code INTEGER NOT NULL,
  request_id TEXT,
  details TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details))
) STRICT;
CREATE INDEX audit_log_at ON audit_log (at);
CREATE INDEX audit_log_last_at ON audit_log (last_at);
CREATE INDEX audit_log_actor_type ON audit_log (actor_type, seq);
CREATE INDEX audit_log_action ON audit_log (action, seq);
CREATE INDEX audit_log_outcome ON audit_log (outcome, seq);
CREATE INDEX audit_log_target ON audit_log (target_type, target_id, seq);
-- LOG-11 coalescing looks up the latest identical failure.
CREATE INDEX audit_log_coalesce ON audit_log (action, outcome, status_code, ip_hash, last_at);
