-- Member score history (#21): one row per quiz a signed-in member finished,
-- graded on the server, and whether each answer was right. A member's
-- results go with the member (ON DELETE CASCADE). A deleted category leaves
-- its results with the category's name at the time (category_name) and no
-- ID; a deleted question leaves its answer row without a question ID.
-- Anonymous play stores nothing.
CREATE TABLE quiz_results (
  id TEXT PRIMARY KEY NOT NULL,
  member_id TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  category_id TEXT REFERENCES categories (id) ON DELETE SET NULL,
  category_name TEXT NOT NULL CHECK (length(category_name) BETWEEN 1 AND 100),
  length TEXT NOT NULL CHECK (length IN ('short', 'long', 'all')),
  score INTEGER NOT NULL CHECK (score >= 0),
  total INTEGER NOT NULL CHECK (total >= 1 AND score <= total),
  finished_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX quiz_results_member_finished ON quiz_results (member_id, finished_at, id);
CREATE INDEX quiz_results_category ON quiz_results (category_id);

-- The graded answers of a result, in the order they were played; never the
-- chosen choices.
CREATE TABLE quiz_result_answers (
  result_id TEXT NOT NULL REFERENCES quiz_results (id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  question_id TEXT REFERENCES questions (id) ON DELETE SET NULL,
  correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (result_id, position)
) STRICT;

CREATE INDEX quiz_result_answers_question ON quiz_result_answers (question_id);
