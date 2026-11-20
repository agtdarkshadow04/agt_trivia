-- Question authoring and review (#19): the member question lists page by
-- creation time, newest first, the ID breaking ties (API-8), for everyone or
-- for one author; a new or changed prompt is compared with the category's
-- other prompts, ignoring case.
CREATE INDEX questions_created ON questions (created_at, id);
CREATE INDEX questions_created_by ON questions (created_by, created_at, id);
CREATE INDEX questions_category_prompt ON questions (category_id, prompt COLLATE NOCASE);
