import { randomUUID } from 'node:crypto';
import { sameText, type CategoryInput } from '../../src/lib/validation.js';
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
