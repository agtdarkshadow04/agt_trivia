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
