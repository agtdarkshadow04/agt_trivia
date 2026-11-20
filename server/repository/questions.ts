import { randomUUID } from 'node:crypto';
import type { QuestionInput, QuestionStatus } from '../../src/lib/validation.js';
import { assertDataWrite } from '../dataWrite.js';
import type { Database } from '../db.js';

/** The `questions` and `question_choices` tables (#15). Callers validate and normalize input first. */

export interface Choice {
  id: string;
  position: number;
  text: string;
  isCorrect: boolean;
}

export interface Question {
  id: string;
  categoryId: string;
  prompt: string;
  status: QuestionStatus;
  authorCredit: string | null;
  createdBy: string | null;
  /** Never public. */
  reviewNote: string;
  approvedBy: string | null;
  approvedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  modifiedBy: string | null;
  /** In the author's order. */
  choices: Choice[];
}

interface QuestionRow {
  id: string;
  category_id: string;
  prompt: string;
  status: QuestionStatus;
  author_credit: string | null;
  created_by: string | null;
  review_note: string;
  approved_by: string | null;
  approved_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  modified_by: string | null;
}

interface ChoiceRow {
  id: string;
  question_id: string;
  position: number;
  text: string;
  is_correct: number;
}

/** The questions of `rows` with their choices, read in one query. */
function withChoices(db: Database, rows: QuestionRow[]): Question[] {
  if (!rows.length) return [];
  const choices = new Map<string, Choice[]>(rows.map((row) => [row.id, []]));
  const placeholders = rows.map(() => '?').join(', ');
  const choiceRows = db.connection.prepare(`SELECT id, question_id, position, text, is_correct FROM question_choices
    WHERE question_id IN (${placeholders}) ORDER BY question_id, position`).all(...rows.map((row) => row.id)) as ChoiceRow[];
  for (const row of choiceRows) choices.get(row.question_id)!.push({ id: row.id, position: row.position, text: row.text, isCorrect: row.is_correct === 1 });
  return rows.map((row) => ({
    id: row.id,
    categoryId: row.category_id,
    prompt: row.prompt,
    status: row.status,
    authorCredit: row.author_credit,
    createdBy: row.created_by,
    reviewNote: row.review_note,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    modifiedBy: row.modified_by,
    choices: choices.get(row.id)!,
  }));
}

export function getQuestion(db: Database, id: string): Question | null {
  const row = db.connection.prepare('SELECT * FROM questions WHERE id = ?').get(id) as QuestionRow | undefined;
  return row ? withChoices(db, [row])[0] : null;
}

/** The approved questions of a category, oldest first: what a public quiz draws from (#15). */
export function approvedQuestions(db: Database, categoryId: string): Question[] {
  const rows = db.connection.prepare("SELECT * FROM questions WHERE category_id = ? AND status = 'approved' ORDER BY created_at, id")
    .all(categoryId) as QuestionRow[];
  return withChoices(db, rows);
}

export interface NewQuestion extends Required<QuestionInput> {
  categoryId: string;
  status: QuestionStatus;
  /** The member who wrote it (#17); null for imported questions. */
  createdBy: string | null;
  /** The member who approved it, when `status` is `approved`. */
  approvedBy?: string | null;
}

/** Inserts a validated, normalized question and its choices in one transaction, and returns it. */
export function insertQuestion(db: Database, input: NewQuestion, now = new Date()): Question {
  assertDataWrite();
  const id = randomUUID();
  const at = now.toISOString();
  db.transaction((sqlite) => {
    sqlite.prepare(`INSERT INTO questions (id, category_id, prompt, status, author_credit, created_by, review_note,
      approved_by, approved_at, version, created_at, updated_at, modified_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(
      id, input.categoryId, input.prompt, input.status, input.authorCredit, input.createdBy, input.reviewNote,
      input.status === 'approved' ? input.approvedBy ?? null : null, input.status === 'approved' ? at : null, at, at, input.createdBy,
    );
    const insertChoice = sqlite.prepare(`INSERT INTO question_choices (id, question_id, position, text, is_correct, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    input.choices.forEach((choice, position) => insertChoice.run(randomUUID(), id, position, choice.text, choice.isCorrect ? 1 : 0, at, at));
  });
  return getQuestion(db, id)!;
}

// --- Authoring and review (#19) ---------------------------------------------------

export interface QuestionPagePosition {
  createdAt: string;
  id: string;
}

export interface QuestionListOptions {
  limit: number;
  after: QuestionPagePosition | null;
  status: QuestionStatus | null;
  categoryId: string | null;
  /** Only the questions this member wrote. */
  createdBy: string | null;
  /** Part of the prompt, ignoring ASCII case. */
  search: string;
}

/** One page of questions, newest first, the ID breaking ties (API-8); `after` is the last question of the previous page. */
export function listQuestions(db: Database, options: QuestionListOptions) {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  if (options.after) {
    conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
    values.push(options.after.createdAt, options.after.createdAt, options.after.id);
  }
  if (options.status) { conditions.push('status = ?'); values.push(options.status); }
  if (options.categoryId) { conditions.push('category_id = ?'); values.push(options.categoryId); }
  if (options.createdBy) { conditions.push('created_by = ?'); values.push(options.createdBy); }
  if (options.search) {
    conditions.push("prompt LIKE ? ESCAPE '\\'");
    values.push(`%${options.search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.connection.prepare(`SELECT * FROM questions ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...values, options.limit + 1) as QuestionRow[];
  return { questions: withChoices(db, rows.slice(0, options.limit)), more: rows.length > options.limit };
}

/** How many questions have each status, of one author or of everyone. */
export function questionCounts(db: Database, createdBy: string | null): Record<QuestionStatus, number> {
  const rows = db.connection.prepare(`SELECT status, count(*) AS n FROM questions ${createdBy ? 'WHERE created_by = ?' : ''} GROUP BY status`)
    .all(...(createdBy ? [createdBy] : [])) as { status: QuestionStatus; n: number }[];
  const counts: Record<QuestionStatus, number> = { draft: 0, pending: 0, approved: 0, rejected: 0 };
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}

/** Whether another question of the category has the same prompt, ignoring ASCII case. */
export function promptTaken(db: Database, categoryId: string, prompt: string, exceptId: string | null) {
  return db.connection.prepare('SELECT 1 FROM questions WHERE category_id = ? AND prompt = ? COLLATE NOCASE AND id IS NOT ?')
    .get(categoryId, prompt, exceptId) !== undefined;
}

/** The display names of members by ID, for the "written by" of question lists. */
export function memberNames(db: Database, ids: readonly string[]): Map<string, string> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = db.connection.prepare(`SELECT id, display_name FROM members WHERE id IN (${unique.map(() => '?').join(', ')})`)
    .all(...unique) as { id: string; display_name: string }[];
  return new Map(rows.map((row) => [row.id, row.display_name]));
}

export interface QuestionContent {
  categoryId: string;
  prompt: string;
  choices: readonly { text: string; isCorrect: boolean }[];
  authorCredit: string | null;
}

/**
 * Replaces a question's content and choices, and optionally its status, when
 * its version is still `version` (optimistic concurrency); returns false when
 * it is not. The version goes up by one.
 */
export function replaceQuestion(db: Database, id: string, version: number, content: QuestionContent, status: QuestionStatus, memberId: string, now = new Date()) {
  assertDataWrite();
  const at = now.toISOString();
  return db.transaction((sqlite) => {
    const result = sqlite.prepare(`UPDATE questions SET category_id = ?, prompt = ?, author_credit = ?, status = ?, version = version + 1,
      updated_at = ?, modified_by = ? WHERE id = ? AND version = ?`).run(content.categoryId, content.prompt, content.authorCredit, status, at, memberId, id, version);
    if (result.changes === 0) return false;
    sqlite.prepare('DELETE FROM question_choices WHERE question_id = ?').run(id);
    const insertChoice = sqlite.prepare(`INSERT INTO question_choices (id, question_id, position, text, is_correct, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    content.choices.forEach((choice, position) => insertChoice.run(randomUUID(), id, position, choice.text, choice.isCorrect ? 1 : 0, at, at));
    return true;
  });
}

export interface StatusChange {
  status: QuestionStatus;
  /** Set on approval, cleared when a question leaves `approved`. */
  approvedBy: string | null;
  approvedAt: string | null;
  reviewNote: string;
}

/** Changes a question's status from `from` when its version is still `version`; returns false when either has changed. */
export function changeQuestionStatus(db: Database, id: string, version: number, from: QuestionStatus, change: StatusChange, memberId: string, now = new Date()) {
  assertDataWrite();
  const result = db.connection.prepare(`UPDATE questions SET status = ?, approved_by = ?, approved_at = ?, review_note = ?, version = version + 1,
    updated_at = ?, modified_by = ? WHERE id = ? AND version = ? AND status = ?`)
    .run(change.status, change.approvedBy, change.approvedAt, change.reviewNote, now.toISOString(), memberId, id, version, from);
  return result.changes === 1;
}

/** Deletes a question and its choices when its version is still `version`; returns false when it is not. */
export function deleteQuestion(db: Database, id: string, version: number) {
  assertDataWrite();
  return db.connection.prepare('DELETE FROM questions WHERE id = ? AND version = ?').run(id, version).changes === 1;
}
