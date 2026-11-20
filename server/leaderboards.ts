import type { PublicCategory } from '../src/lib/api.js';
import { isUuidV4 } from '../src/lib/api.js';
import { displayPercent } from '../src/lib/quiz.js';
import { settingValues, type AppContext } from './context.js';
import { HttpError } from './http.js';
import { getCategory } from './repository/categories.js';
import { leaderboardOptIn, setLeaderboardOptIn } from './repository/members.js';
import { leaderboard } from './repository/results.js';
import { readSettings } from './repository/settings.js';

/**
 * Opt-in leaderboards (#49). Off unless the Admin turns on
 * `leaderboards.enabled`; then each category has a public board of the
 * active members who chose to appear on it, by display name only (API-3):
 * no member ID, username or AGT traveller ID leaves the server.
 */

export interface LeaderboardEntry {
  rank: number;
  displayName: string;
  bestPercent: number;
  plays: number;
}

export interface PublicLeaderboard {
  category: PublicCategory;
  /** Results count from a quiz of any length with at least this many answers (#60). */
  minimumAnswers: number;
  entries: LeaderboardEntry[];
}

export function leaderboardsEnabled(context: AppContext) {
  return settingValues(context.config, readSettings(context.db))['leaderboards.enabled'];
}

/** A category's board; `403 leaderboards_closed` while the feature is off, `404` for an unknown category. */
export function publicLeaderboard(context: AppContext, categoryId: string): PublicLeaderboard {
  const values = settingValues(context.config, readSettings(context.db));
  if (!values['leaderboards.enabled']) throw new HttpError(403, 'leaderboards_closed', 'Leaderboards are turned off.');
  // API-5: a malformed ID is just another unknown category.
  const category = isUuidV4(categoryId) ? getCategory(context.db, categoryId.toLowerCase()) : null;
  if (!category) throw new HttpError(404, 'not_found', 'The category does not exist.');
  // A category smaller than a short quiz still has a board: its full quiz counts.
  const minimumAnswers = Math.max(1, Math.min(values['quiz.shortLength'], category.questionCount));
  const rows = leaderboard(context.db, { categoryId: category.id, minimumAnswers, limit: values['leaderboards.size'] });
  const { id, shortName, name, description, priority, questionCount } = category;
  return {
    category: { id, shortName, name, description, priority, questionCount },
    minimumAnswers,
    entries: rows.map((row, index) => ({ rank: index + 1, displayName: row.displayName, bestPercent: displayPercent(row.bestPercent), plays: row.plays })),
  };
}

/** A member's own preferences (#49): for now, whether they appear on leaderboards. */
export function memberPreferences(context: AppContext, memberId: string) {
  return { leaderboardOptIn: leaderboardOptIn(context.db, memberId) };
}

export function updateMemberPreferences(context: AppContext, memberId: string, input: { leaderboardOptIn: boolean }) {
  setLeaderboardOptIn(context.db, memberId, input.leaderboardOptIn);
  return memberPreferences(context, memberId);
}
