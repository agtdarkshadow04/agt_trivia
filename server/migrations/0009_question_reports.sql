-- Members' reports of a problem with an approved question (#46): a reason, an
-- optional note, and what a Moderator did with it. A report goes with its
-- question (ON DELETE CASCADE). member_id and resolved_by name members, set to
-- null when the member is deleted, in the same transaction, as for questions.
CREATE TABLE question_reports (
  id TEXT PRIMARY KEY NOT NULL,
  question_id TEXT NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  member_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('wrong_answer', 'unclear', 'typo', 'outdated', 'other')),
  note TEXT NOT NULL CHECK (length(note) <= 500),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution_note TEXT NOT NULL CHECK (length(resolution_note) <= 500),
  resolved_by TEXT,
  resolved_at TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- A member has at most one open report per question.
CREATE UNIQUE INDEX question_reports_open ON question_reports (question_id, member_id) WHERE status = 'open';
-- The Moderators' list pages by status, oldest first, the ID breaking ties (API-8).
CREATE INDEX question_reports_status_created ON question_reports (status, created_at, id);
CREATE INDEX question_reports_member ON question_reports (member_id);
