-- Member accounts (#17, the AUTH-1 deviation): players, editors and moderators
-- besides the single Admin, who is not a member. Local members sign in with a
-- username and password; AGT members (auth_source 'agt_iam', #18) have neither
-- and get their own columns there. Usernames are stored lowercase.
CREATE TABLE members (
  id TEXT PRIMARY KEY NOT NULL,
  auth_source TEXT NOT NULL CHECK (auth_source IN ('local', 'agt_iam')),
  username TEXT CHECK (username IS NULL OR (
    length(username) BETWEEN 3 AND 64 AND username = lower(username) AND username NOT GLOB '*[^a-z0-9_.-]*'
  )),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('Player', 'Editor', 'Moderator')),
  is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (auth_source <> 'local' OR (username IS NOT NULL AND password_hash IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX members_username ON members (username);
-- The Admin's member list: newest first, the ID breaking ties (API-8).
CREATE INDEX members_created ON members (created_at, id);

-- Member sessions (AUTH-8): only the SHA-256 of each token is stored. Never
-- part of a backup, and emptied by every restore (BAK-2, BAK-4).
CREATE TABLE member_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  member_id TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX member_sessions_member ON member_sessions (member_id);
CREATE INDEX member_sessions_expires_at ON member_sessions (expires_at);
