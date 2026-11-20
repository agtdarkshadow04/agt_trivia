import { randomUUID } from 'node:crypto';
import { sameText, type CategoryInput, type QuestionStatus } from '../../src/lib/validation.js';
import { sortCategories } from '../../src/lib/quiz.js';
import { assertDataWrite } from '../dataWrite.js';
import type { Database } from '../db.js';

/** The `categories` table (#15). Callers validate and normalize input first (`src/lib/validation.ts`). */

export interface Category {
  id: string;
  shortName: string;
  name: string;
  description: string;
  priority: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Approved questions only: what a quiz can draw from. */
  questionCount: number;
}

interface CategoryRow {
  id: string;
  short_name: string;
  name: string;
  description: string;
  priority: number;
  version: number;
  created_at: string;
  updated_at: string;
  question_count: number;
}

const selectCategories = `SELECT categories.*,
  (SELECT count(*) FROM questions WHERE questions.category_id = categories.id AND questions.status = 'approved') AS question_count
  FROM categories`;

function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    shortName: row.short_name,
    name: row.name,
    description: row.description,
    priority: row.priority,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    questionCount: row.question_count,
  };
}

/** Every category, lower priority first, then by name ignoring case and accents (as 1.x sorted them). */
export function listCategories(db: Database): Category[] {
  return sortCategories((db.connection.prepare(selectCategories).all() as CategoryRow[]).map(toCategory));
}

export function getCategory(db: Database, id: string): Category | null {
  const row = db.connection.prepare(`${selectCategories} WHERE categories.id = ?`).get(id) as CategoryRow | undefined;
  return row ? toCategory(row) : null;
}

/**
 * The fields of `input` another category already uses, ignoring case
 * (`shortName`, `name`); `exceptId` is the category being edited.
 */
export function categoryConflicts(db: Database, input: Pick<CategoryInput, 'shortName' | 'name'>, exceptId: string | null = null) {
  const others = (db.connection.prepare('SELECT id, short_name, name FROM categories').all() as Pick<CategoryRow, 'id' | 'short_name' | 'name'>[])
    .filter((row) => row.id !== exceptId);
  const fields: ('shortName' | 'name')[] = [];
  if (others.some((row) => sameText(row.short_name, input.shortName))) fields.push('shortName');
  if (others.some((row) => sameText(row.name, input.name))) fields.push('name');
  return fields;
}

/** Inserts a validated, normalized category and returns it. */
export function insertCategory(db: Database, input: CategoryInput, now = new Date()): Category {
  assertDataWrite();
  const id = randomUUID();
  const at = now.toISOString();
  db.connection.prepare(`INSERT INTO categories (id, short_name, name, description, priority, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(id, input.shortName, input.name, input.description, input.priority, at, at);
  return getCategory(db, id)!;
}

// --- Category management (#20) ----------------------------------------------------

/** How many questions of each status every category has, by category ID; categories without questions are absent. */
export function categoryStatusCounts(db: Database): Map<string, Record<QuestionStatus, number>> {
  const rows = db.connection.prepare('SELECT category_id, status, count(*) AS n FROM questions GROUP BY category_id, status')
    .all() as { category_id: string; status: QuestionStatus; n: number }[];
  const counts = new Map<string, Record<QuestionStatus, number>>();
  for (const row of rows) {
    const entry = counts.get(row.category_id) ?? { draft: 0, pending: 0, approved: 0, rejected: 0 };
    entry[row.status] = row.n;
    counts.set(row.category_id, entry);
  }
  return counts;
}

/** Every question of a category, whatever its status. */
export function categoryQuestionCount(db: Database, id: string) {
  return (db.connection.prepare('SELECT count(*) AS n FROM questions WHERE category_id = ?').get(id) as { n: number }).n;
}

/**
 * Replaces a validated, normalized category when its version is still
 * `version` (optimistic concurrency); returns false when it is not.
 */
export function updateCategory(db: Database, id: string, version: number, input: CategoryInput, now = new Date()) {
  assertDataWrite();
  return db.connection.prepare(`UPDATE categories SET short_name = ?, name = ?, description = ?, priority = ?, version = version + 1, updated_at = ?
    WHERE id = ? AND version = ?`).run(input.shortName, input.name, input.description, input.priority, now.toISOString(), id, version).changes === 1;
}

/**
 * Deletes a category without questions when its version is still `version`;
 * returns false when it is not. The foreign key refuses a category that has
 * questions, so none is ever orphaned; callers check first to say why.
 */
export function deleteCategory(db: Database, id: string, version: number) {
  assertDataWrite();
  return db.connection.prepare('DELETE FROM categories WHERE id = ? AND version = ?').run(id, version).changes === 1;
}
