import { randomUUID } from 'node:crypto';
import { assertDataWrite } from '../dataWrite.js';
import type { Database } from '../db.js';

/** Ranked runs (#66): `ranked_runs`, `ranked_answers` and `categories.ranked`. */

export type RunStatus = 'active' | 'finished' | 'forfeited';
export type AnswerStatus = 'pending' | 'served' | 'answered' | 'expired' | 'left_out';

export interface Run {
  id: string;
  memberId: string;
  status: RunStatus;
  questionCount: number;
  secondsPerQuestion: number;
  score: number;
  correctCount: number;
  countedCount: number;
  answerMsTotal: number;
  answeredCount: number;
  startedAt: string;
  finishedAt: string | null;
}

interface RunRow {
  id: string;
  member_id: string;
  status: RunStatus;
  question_count: number;
  seconds_per_question: number;
  score: number;
  correct_count: number;
  counted_count: number;
  answer_ms_total: number;
  answered_count: number;
  started_at: string;
  finished_at: string | null;
}

export interface RunAnswer {
  position: number;
  questionId: string | null;
  categoryId: string | null;
  status: AnswerStatus;
  servedAt: string | null;
  answeredAt: string | null;
  correct: boolean;
  points: number;
}

interface AnswerRow {
  position: number;
  question_id: string | null;
  category_id: string | null;
  status: AnswerStatus;
  served_at: string | null;
  answered_at: string | null;
  correct: number;
  points: number;
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    memberId: row.member_id,
    status: row.status,
    questionCount: row.question_count,
    secondsPerQuestion: row.seconds_per_question,
    score: row.score,
    correctCount: row.correct_count,
    countedCount: row.counted_count,
    answerMsTotal: row.answer_ms_total,
    answeredCount: row.answered_count,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function toAnswer(row: AnswerRow): RunAnswer {
  return {
    position: row.position,
    questionId: row.question_id,
    categoryId: row.category_id,
    status: row.status,
    servedAt: row.served_at,
    answeredAt: row.answered_at,
    correct: row.correct === 1,
    points: row.points,
  };
}

/** The approved questions of the categories included in ranked runs: what a run draws from. */
export function rankedPool(db: Database): { id: string; categoryId: string }[] {
  return db.connection.prepare(`SELECT questions.id AS id, questions.category_id AS categoryId
    FROM questions JOIN categories ON categories.id = questions.category_id
    WHERE questions.status = 'approved' AND categories.ranked = 1 ORDER BY questions.id`).all() as { id: string; categoryId: string }[];
}

/** The questions a member was shown in ranked runs since `since` (the cooldown). */
export function questionsShownSince(db: Database, memberId: string, since: string): Set<string> {
  const rows = db.connection.prepare(`SELECT DISTINCT ranked_answers.question_id AS id FROM ranked_answers
    JOIN ranked_runs ON ranked_runs.id = ranked_answers.run_id
    WHERE ranked_runs.member_id = ? AND ranked_answers.served_at IS NOT NULL AND ranked_answers.served_at >= ?
      AND ranked_answers.question_id IS NOT NULL`).all(memberId, since) as { id: string }[];
  return new Set(rows.map((row) => row.id));
}

export function getRun(db: Database, id: string): Run | null {
  const row = db.connection.prepare('SELECT * FROM ranked_runs WHERE id = ?').get(id) as RunRow | undefined;
  return row ? toRun(row) : null;
}

export function activeRun(db: Database, memberId: string): Run | null {
  const row = db.connection.prepare("SELECT * FROM ranked_runs WHERE member_id = ? AND status = 'active'").get(memberId) as RunRow | undefined;
  return row ? toRun(row) : null;
}

export function runAnswers(db: Database, runId: string): RunAnswer[] {
  return (db.connection.prepare('SELECT * FROM ranked_answers WHERE run_id = ? ORDER BY position').all(runId) as AnswerRow[]).map(toAnswer);
}

/** A new active run with its drawn questions, all pending. */
export function insertRun(db: Database, input: { memberId: string; secondsPerQuestion: number; questions: readonly { id: string; categoryId: string }[] }, now = new Date()): Run {
  assertDataWrite();
  const at = now.toISOString();
  const id = randomUUID();
  db.transaction(() => {
    db.connection.prepare(`INSERT INTO ranked_runs (id, member_id, status, question_count, seconds_per_question, started_at, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`).run(id, input.memberId, input.questions.length, input.secondsPerQuestion, at, at, at);
    const insert = db.connection.prepare(`INSERT INTO ranked_answers (run_id, position, question_id, category_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)`);
    input.questions.forEach((question, position) => insert.run(id, position, question.id, question.categoryId, at, at));
  });
  return getRun(db, id)!;
}

export function markServed(db: Database, runId: string, position: number, now = new Date()) {
  assertDataWrite();
  const at = now.toISOString();
  db.connection.prepare("UPDATE ranked_answers SET status = 'served', served_at = ?, updated_at = ? WHERE run_id = ? AND position = ? AND status = 'pending'")
    .run(at, at, runId, position);
}

/** Closes a question: answered (with whether it was right and its points), expired or left out. */
export function closeAnswer(db: Database, runId: string, position: number, outcome: { status: 'answered' | 'expired' | 'left_out'; answeredAt?: string | null; correct?: boolean; points?: number }, now = new Date()) {
  assertDataWrite();
  db.connection.prepare(`UPDATE ranked_answers SET status = ?, answered_at = ?, correct = ?, points = ?, updated_at = ?
    WHERE run_id = ? AND position = ? AND status IN ('pending', 'served')`)
    .run(outcome.status, outcome.answeredAt ?? null, outcome.correct ? 1 : 0, outcome.points ?? 0, now.toISOString(), runId, position);
}

/** Ends a run with its totals, and the streak bonus folded into the answers' points. */
export function endRun(db: Database, runId: string, status: 'finished' | 'forfeited', totals: {
  score: number; correctCount: number; countedCount: number; answerMsTotal: number; answeredCount: number; points: readonly { position: number; points: number }[];
}, now = new Date()) {
  assertDataWrite();
  const at = now.toISOString();
  db.transaction(() => {
    const update = db.connection.prepare('UPDATE ranked_answers SET points = ?, updated_at = ? WHERE run_id = ? AND position = ?');
    for (const { position, points } of totals.points) update.run(points, at, runId, position);
    db.connection.prepare(`UPDATE ranked_runs SET status = ?, score = ?, correct_count = ?, counted_count = ?, answer_ms_total = ?, answered_count = ?,
        finished_at = ?, updated_at = ? WHERE id = ? AND status = 'active'`)
      .run(status, totals.score, totals.correctCount, totals.countedCount, totals.answerMsTotal, totals.answeredCount, at, at, runId);
  });
}

/** A member's ended runs, newest first. */
export function endedRuns(db: Database, memberId: string, limit: number): Run[] {
  return (db.connection.prepare(`SELECT * FROM ranked_runs WHERE member_id = ? AND status != 'active'
    ORDER BY finished_at DESC, id DESC LIMIT ?`).all(memberId, limit) as RunRow[]).map(toRun);
}

export function endedRunCount(db: Database, memberId: string): number {
  return (db.connection.prepare("SELECT count(*) AS count FROM ranked_runs WHERE member_id = ? AND status != 'active'").get(memberId) as { count: number }).count;
}

export interface BoardRow {
  memberId: string;
  displayName: string;
  /** The mean score of the member's latest `ratingRuns` ended runs. */
  rating: number;
  /** Every ended run. */
  runs: number;
  correct: number;
  counted: number;
  /** When the latest run in the rating ended. */
  ratedAt: string;
}

/** The rating of every active member who chose to appear on leaderboards and has ended at least one run. */
export function boardRows(db: Database, ratingRuns: number): BoardRow[] {
  return db.connection.prepare(`WITH ended AS (
      SELECT member_id, score, correct_count, counted_count, finished_at,
        row_number() OVER (PARTITION BY member_id ORDER BY finished_at DESC, id DESC) AS position,
        count(*) OVER (PARTITION BY member_id) AS runs
      FROM ranked_runs WHERE status != 'active')
    SELECT members.id AS memberId, members.display_name AS displayName, avg(ended.score) AS rating, max(ended.runs) AS runs,
      sum(ended.correct_count) AS correct, sum(ended.counted_count) AS counted, max(ended.finished_at) AS ratedAt
    FROM ended JOIN members ON members.id = ended.member_id
    WHERE ended.position <= ? AND members.is_active = 1 AND members.leaderboard_opt_in = 1
    GROUP BY members.id`).all(ratingRuns) as BoardRow[];
}

export interface RankedCategoryRow {
  id: string;
  shortName: string;
  name: string;
  questionCount: number;
  ranked: boolean;
}

/** Every category with its approved questions and whether ranked runs draw from it, by name. */
export function rankedCategories(db: Database): RankedCategoryRow[] {
  const rows = db.connection.prepare(`SELECT categories.id AS id, short_name AS shortName, name, ranked,
      (SELECT count(*) FROM questions WHERE questions.category_id = categories.id AND questions.status = 'approved') AS questionCount
    FROM categories ORDER BY name COLLATE NOCASE, id`).all() as (Omit<RankedCategoryRow, 'ranked'> & { ranked: number })[];
  return rows.map((row) => ({ ...row, ranked: row.ranked === 1 }));
}

/** Includes or leaves out categories; returns how many changed. Unknown IDs change nothing. */
export function setCategoriesRanked(db: Database, changes: readonly { id: string; ranked: boolean }[]): number {
  assertDataWrite();
  let changed = 0;
  db.transaction(() => {
    const update = db.connection.prepare('UPDATE categories SET ranked = ? WHERE id = ? AND ranked != ?');
    for (const { id, ranked } of changes) changed += update.run(ranked ? 1 : 0, id, ranked ? 1 : 0).changes;
  });
  return changed;
}
