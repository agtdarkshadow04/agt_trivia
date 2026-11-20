-- Whether a member chose to appear on the public leaderboards (#49), by
-- display name only. Off for everyone until they turn it on themselves.
ALTER TABLE members ADD COLUMN leaderboard_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (leaderboard_opt_in IN (0, 1));

-- A category's leaderboard reads its results.
CREATE INDEX quiz_results_category_member ON quiz_results (category_id, member_id);
