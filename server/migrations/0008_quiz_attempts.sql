-- Generated secrets that belong to the data (SEC-8): created at startup, and at
-- the end of a restore, when missing; never by a request (BAK-8). They are part
-- of the database, so backups carry them. The first is the key that signs quiz
-- attempts (#45).
CREATE TABLE app_secrets (
  name TEXT PRIMARY KEY NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- The signed quiz attempt a result was saved from (#45): each attempt is saved
-- once. Results saved without one, and every result from before, have none.
ALTER TABLE quiz_results ADD COLUMN attempt_id TEXT CHECK (attempt_id IS NULL OR length(attempt_id) = 36);

CREATE UNIQUE INDEX quiz_results_attempt ON quiz_results (attempt_id);
