-- When each member last signed in (#48), local or with their AGT account; null
-- until their first sign-in. The Members tab shows it and filters members who
-- have not signed in for a while.
ALTER TABLE members ADD COLUMN last_sign_in_at TEXT;

CREATE INDEX members_last_sign_in ON members (last_sign_in_at);
