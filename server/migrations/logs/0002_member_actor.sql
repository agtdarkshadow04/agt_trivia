-- LOG-10 (#17): members act too. SQLite cannot change a CHECK constraint, so
-- audit_log is rebuilt with 'member' allowed, keeping every entry and its seq.
CREATE TABLE audit_log_new (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'member', 'anonymous')),
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
INSERT INTO audit_log_new SELECT * FROM audit_log;
DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;
CREATE INDEX audit_log_at ON audit_log (at);
CREATE INDEX audit_log_last_at ON audit_log (last_at);
CREATE INDEX audit_log_actor_type ON audit_log (actor_type, seq);
CREATE INDEX audit_log_action ON audit_log (action, seq);
CREATE INDEX audit_log_outcome ON audit_log (outcome, seq);
CREATE INDEX audit_log_target ON audit_log (target_type, target_id, seq);
CREATE INDEX audit_log_coalesce ON audit_log (action, outcome, status_code, ip_hash, last_at);
