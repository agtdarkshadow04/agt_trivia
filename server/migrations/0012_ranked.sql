-- Ranked mode (#66): server-run, timed runs of questions drawn from the
-- categories the Admin includes, scored on the server, never showing a
-- correct answer. A member's runs go with the member (ON DELETE CASCADE).

-- Whether a category's approved questions can be drawn into ranked runs; every
-- category is included until the Admin leaves it out.
ALTER TABLE categories ADD COLUMN ranked INTEGER NOT NULL DEFAULT 1 CHECK (ranked IN (0, 1));

-- One run: its settings when it started, and its totals once it ends. Only a
-- finished or forfeited run counts towards a rating; a member has at most one
-- active run.
CREATE TABLE ranked_runs (
  id TEXT PRIMARY KEY NOT NULL,
  member_id TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'finished', 'forfeited')),
  question_count INTEGER NOT NULL CHECK (question_count >= 1),
  seconds_per_question INTEGER NOT NULL CHECK (seconds_per_question >= 1),
  score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
  correct_count INTEGER NOT NULL DEFAULT 0 CHECK (correct_count >= 0),
  -- The questions that counted: all of them, less those unapproved or deleted during the run.
  counted_count INTEGER NOT NULL DEFAULT 0 CHECK (counted_count >= 0 AND correct_count <= counted_count),
  answer_ms_total INTEGER NOT NULL DEFAULT 0 CHECK (answer_ms_total >= 0),
  answered_count INTEGER NOT NULL DEFAULT 0 CHECK (answered_count >= 0),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status = 'active') = (finished_at IS NULL))
) STRICT;

CREATE INDEX ranked_runs_member ON ranked_runs (member_id, finished_at, id);
CREATE UNIQUE INDEX ranked_runs_one_active ON ranked_runs (member_id) WHERE status = 'active';

-- The questions of a run in the order drawn: when each was shown and answered,
-- whether the answer was right, and its points. Never the choices chosen.
CREATE TABLE ranked_answers (
  run_id TEXT NOT NULL REFERENCES ranked_runs (id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  question_id TEXT REFERENCES questions (id) ON DELETE SET NULL,
  category_id TEXT REFERENCES categories (id) ON DELETE SET NULL,
  -- pending: not shown yet; served: shown, waiting for the answer; answered;
  -- expired: no answer in time; left_out: unapproved or deleted during the run.
  status TEXT NOT NULL CHECK (status IN ('pending', 'served', 'answered', 'expired', 'left_out')),
  served_at TEXT,
  answered_at TEXT,
  correct INTEGER NOT NULL DEFAULT 0 CHECK (correct IN (0, 1)),
  points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, position)
) STRICT;

CREATE INDEX ranked_answers_question ON ranked_answers (question_id);
