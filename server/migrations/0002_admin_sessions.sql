-- The single installation Admin (AUTH-1): at most one row.
CREATE TABLE admin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL CHECK (length(username) BETWEEN 1 AND 64),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- Admin sessions (AUTH-8): only the SHA-256 of each token is stored. Never
-- part of a backup, and emptied by every restore (#13).
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX sessions_expires_at ON sessions (expires_at);
