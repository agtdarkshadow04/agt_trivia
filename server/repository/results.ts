import { randomUUID } from 'node:crypto';
import type { QuizLength } from '../../src/lib/api.js';
import { assertDataWrite } from '../dataWrite.js';
import type { Database } from '../db.js';

/** The `quiz_results` and `quiz_result_answers` tables (#21): a member's graded quizzes. Callers grade first. */

export interface StoredResult {
  id: string;
  memberId: string;
  categoryId: string | null;
  categoryName: string;
  length: QuizLength;
  score: number;
  total: number;
  finishedAt: string;
  /** The signed quiz attempt it was saved from (#45), or null. */
  attemptId: string | null;
}

interface ResultRow {
  id: string;
  member_id: string;
  category_id: string | null;
  category_name: string;
  length: QuizLength;
  score: number;
  total: number;
  finished_at: string;
  attempt_id: string | null;
}

function toResult(row: ResultRow): StoredResult {
  return {
    id: row.id,
    memberId: row.member_id,
    categoryId: row.category_id,
    categoryName: row.category_name,
    length: row.length,
    score: row.score,
    total: row.total,
    finishedAt: row.finished_at,
    attemptId: row.attempt_id,
  };
}

export interface NewResult {
  memberId: string;
  categoryId: string;
  categoryName: string;
  length: QuizLength;
  /** The verified attempt (#45), or null for a result sent without one. */
  attemptId?: string | null;
  /** In the order they were played; `correct` only, never the chosen choices. */
  answers: readonly { questionId: string; correct: boolean }[];
}

/** Stores a graded result and its answers in one transaction, and returns it. */
export function insertResult(db: Database, input: NewResult, now = new Date()): StoredResult {
  assertDataWrite();
  const id = randomUUID();
  const at = now.toISOString();
  const score = input.answers.filter((answer) => answer.correct).length;
  db.transaction((sqlite) => {
    sqlite.prepare(`INSERT INTO quiz_results (id, member_id, category_id, category_name, length, score, total, finished_at, attempt_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.memberId, input.categoryId, input.categoryName, input.length, score, input.answers.length, at, input.attemptId ?? null, at, at);
    const answer = sqlite.prepare('INSERT INTO quiz_result_answers (result_id, position, question_id, correct, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    input.answers.forEach((entry, position) => answer.run(id, position, entry.questionId, entry.correct ? 1 : 0, at, at));
  });
  return toResult(db.connection.prepare('SELECT * FROM quiz_results WHERE id = ?').get(id) as ResultRow);
}

/** The result saved from a quiz attempt (#45), by any member, or null. */
export function getResultByAttempt(db: Database, attemptId: string): StoredResult | null {
  const row = db.connection.prepare('SELECT * FROM quiz_results WHERE attempt_id = ?').get(attemptId) as ResultRow | undefined;
  return row ? toResult(row) : null;
}

export interface ResultPagePosition {
  finishedAt: string;
  id: string;
}

/** One page of a member's results, newest first, the ID breaking ties (API-8); optionally of one category. */
export function listResults(db: Database, options: { memberId: string; categoryId: string | null; limit: number; after: ResultPagePosition | null }) {
  const conditions = ['member_id = ?'];
  const values: (string | number)[] = [options.memberId];
  if (options.categoryId) { conditions.push('category_id = ?'); values.push(options.categoryId); }
  if (options.after) {
    conditions.push('(finished_at < ? OR (finished_at = ? AND id < ?))');
    values.push(options.after.finishedAt, options.after.finishedAt, options.after.id);
  }
  const rows = db.connection.prepare(`SELECT * FROM quiz_results WHERE ${conditions.join(' AND ')} ORDER BY finished_at DESC, id DESC LIMIT ?`)
    .all(...values, options.limit + 1) as ResultRow[];
  return { results: rows.slice(0, options.limit).map(toResult), more: rows.length > options.limit };
}

export interface CategoryStatsRow {
  categoryId: string;
  categoryName: string;
  plays: number;
  /** The best and the mean of the results' percentages, 0 to 100, not rounded. */
  bestPercent: number;
  averagePercent: number;
  lastPlayedAt: string;
}

/** A member's results per category that still exists, by the category's current name. */
export function memberStats(db: Database, memberId: string): CategoryStatsRow[] {
  return (db.connection.prepare(`SELECT quiz_results.category_id AS categoryId, categories.name AS categoryName, count(*) AS plays,
      max(100.0 * score / total) AS bestPercent, avg(100.0 * score / total) AS averagePercent, max(finished_at) AS lastPlayedAt
    FROM quiz_results JOIN categories ON categories.id = quiz_results.category_id
    WHERE member_id = ? GROUP BY quiz_results.category_id ORDER BY lastPlayedAt DESC`).all(memberId) as CategoryStatsRow[]);
}

/** Deletes every result of a member, with their answers; returns how many. */
export function deleteMemberResults(db: Database, memberId: string) {
  assertDataWrite();
  return db.connection.prepare('DELETE FROM quiz_results WHERE member_id = ?').run(memberId).changes;
}

export interface LeaderboardRow {
  memberId: string;
  displayName: string;
  /** The best result's exact percentage, 0 to 100. */
  bestPercent: number;
  plays: number;
  /** When the member first reached their best. */
  bestAt: string;
}

/**
 * A category's leaderboard (#49): active members who opted in, by their best
 * result, then by more plays, then by who reached it first. Only results
 * saved from a signed quiz attempt (#45) with at least `minimumAnswers`
 * answers count, whatever the quiz length (#60), so a hand-made result or a
 * very small draw never places anyone.
 */
export function leaderboard(db: Database, options: { categoryId: string; minimumAnswers: number; limit: number }): LeaderboardRow[] {
  return db.connection.prepare(`WITH eligible AS (
      SELECT quiz_results.member_id, 100.0 * quiz_results.score / quiz_results.total AS percent, quiz_results.finished_at
      FROM quiz_results JOIN members ON members.id = quiz_results.member_id
      WHERE quiz_results.category_id = ? AND quiz_results.attempt_id IS NOT NULL
        AND quiz_results.total >= ? AND members.is_active = 1 AND members.leaderboard_opt_in = 1
    ), best AS (
      SELECT member_id, max(percent) AS best_percent, count(*) AS plays FROM eligible GROUP BY member_id
    )
    SELECT best.member_id AS memberId, members.display_name AS displayName, best.best_percent AS bestPercent, best.plays AS plays,
      (SELECT min(eligible.finished_at) FROM eligible WHERE eligible.member_id = best.member_id AND eligible.percent = best.best_percent) AS bestAt
    FROM best JOIN members ON members.id = best.member_id
    ORDER BY best.best_percent DESC, best.plays DESC, bestAt, best.member_id
    LIMIT ?`).all(options.categoryId, options.minimumAnswers, options.limit) as LeaderboardRow[];
}
