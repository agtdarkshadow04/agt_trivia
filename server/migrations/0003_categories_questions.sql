-- Quiz categories (#15): the Google Sheet's categories table. The sheet's
-- catTheme and adminNotes are not kept. short_name is used in ?category= links.
-- Names are unique ignoring ASCII case here; the app also compares them
-- ignoring case in every script before it writes.
CREATE TABLE categories (
  id TEXT PRIMARY KEY NOT NULL,
  short_name TEXT NOT NULL CHECK (length(short_name) BETWEEN 1 AND 16 AND short_name NOT GLOB '*[^A-Za-z0-9-]*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 100),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX categories_short_name ON categories (short_name COLLATE NOCASE);
CREATE UNIQUE INDEX categories_name ON categories (name COLLATE NOCASE);

-- Questions (#15): the sheet's questions table. Only approved questions are
-- public. review_note (the sheet's adminNotes) is never public. created_by,
-- approved_by and modified_by name members, which arrive in #17; deleting a
-- member sets them to null in the same transaction.
CREATE TABLE questions (
  id TEXT PRIMARY KEY NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 300),
  status TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'approved', 'rejected')),
  author_credit TEXT CHECK (author_credit IS NULL OR length(author_credit) BETWEEN 1 AND 64),
  created_by TEXT,
  review_note TEXT NOT NULL CHECK (length(review_note) <= 1000),
  approved_by TEXT,
  approved_at TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  modified_by TEXT
) STRICT;

CREATE INDEX questions_category_status ON questions (category_id, status);

-- The 2 to 4 answer choices of a question, in the author's order. A question
-- with more than one correct choice is a multi-answer question.
CREATE TABLE question_choices (
  id TEXT PRIMARY KEY NOT NULL,
  question_id TEXT NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 3),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 200),
  is_correct INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX question_choices_position ON question_choices (question_id, position);
CREATE UNIQUE INDEX question_choices_text ON question_choices (question_id, text COLLATE NOCASE);
