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
  };
}

export interface NewResult {
  memberId: string;
  categoryId: string;
  categoryName: string;
  length: QuizLength;
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
    sqlite.prepare(`INSERT INTO quiz_results (id, member_id, category_id, category_name, length, score, total, finished_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.memberId, input.categoryId, input.categoryName, input.length, score, input.answers.length, at, at, at);
    const answer = sqlite.prepare('INSERT INTO quiz_result_answers (result_id, position, question_id, correct, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    input.answers.forEach((entry, position) => answer.run(id, position, entry.questionId, entry.correct ? 1 : 0, at, at));
  });
  return toResult(db.connection.prepare('SELECT * FROM quiz_results WHERE id = ?').get(id) as ResultRow);
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
