-- AGT sign-in through AGT IAM (#18). AGT members (auth_source 'agt_iam') have
-- no username or password; they are found by their AGT traveller ID, and IAM
-- sets their name and role at every sign-in. Their security level is not kept:
-- the game has no per-category visibility. The app writes these columns only
-- for AGT members.
ALTER TABLE members ADD COLUMN iam_traveller_id TEXT CHECK (iam_traveller_id IS NULL OR length(iam_traveller_id) BETWEEN 1 AND 200);
ALTER TABLE members ADD COLUMN iam_traveller_name TEXT CHECK (iam_traveller_name IS NULL OR length(iam_traveller_name) BETWEEN 1 AND 42);
ALTER TABLE members ADD COLUMN iam_permission TEXT CHECK (iam_permission IS NULL OR length(iam_permission) <= 200);
ALTER TABLE members ADD COLUMN iam_synced_at TEXT;

CREATE UNIQUE INDEX members_iam_traveller_id ON members (iam_traveller_id);
