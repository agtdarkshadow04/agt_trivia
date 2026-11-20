import type { FastifyRequest } from 'fastify';
import { fieldError, type FieldError } from '../src/lib/errors.js';
import { readCategories, readQuestions, type ImportFile, type SheetCategory, type SheetQuestion } from '../src/lib/sheetImport.js';
import { sameText } from '../src/lib/validation.js';
import type { AppContext } from './context.js';
import { HttpError } from './http.js';
import { insertCategory, listCategories } from './repository/categories.js';
import { insertQuestion, promptTaken } from './repository/questions.js';

/**
 * The Admin's import of the 1.x Google Sheet (#22). The Admin downloads
 * `validCategories` and `pendingQuestions` as CSV and uploads them; the server
 * never fetches the sheet (SEC-14). The files are read into memory, checked as
 * UTF-8 text and parsed, then discarded: they are never written to disk,
 * stored or served (the SEC-9 deviation). A preview changes nothing; an import
 * writes everything in one transaction, and skips what already exists, so a
 * second import adds nothing.
 */

/** Each file may be at most 1 MiB (the SEC-9 deviation). */
export const maxImportFileBytes = 1024 * 1024;

/** What browsers send for a `.csv` file: `text/csv`, or `text/plain`, and `application/vnd.ms-excel` on Windows with Excel installed. */
export const importMediaTypes: readonly string[] = ['text/csv', 'text/plain', 'application/vnd.ms-excel'];

export interface ImportUpload {
  action: 'preview' | 'import';
  files: Partial<Record<ImportFile, string>>;
}

export interface ImportReport {
  action: 'preview' | 'import';
  /** True once the import has been written; false for a preview. */
  imported: boolean;
  categories: { create: number; skip: number };
  questions: { create: number; skip: number; approved: number; pending: number };
  /** Every bad row, naming the file (`field`), the `row` and the `column`; an import with any is refused. */
  problems: FieldError[];
}

function badFile(file: ImportFile, message: string, code: 'invalid_format' | 'not_allowed' = 'invalid_format'): never {
  throw new HttpError(400, 'validation_failed', message, { fields: [fieldError(file, code, message)] });
}

/**
 * Reads the multipart body before the data write (the route's `prepare`
 * step): the `action` field and the `categories` and `questions` files, each
 * at most 1 MiB, a CSV or plain-text media type, valid UTF-8 without NUL
 * bytes. Nothing touches the disk.
 */
export async function readImportUpload(request: FastifyRequest): Promise<ImportUpload> {
  if (!request.isMultipart()) throw new HttpError(415, 'multipart_required', 'The files must be uploaded as multipart/form-data.');
  let action: string | undefined;
  const files: Partial<Record<ImportFile, string>> = {};
  try {
    for await (const part of request.parts({ limits: { fileSize: maxImportFileBytes, files: 2, fields: 1, parts: 3 } })) {
      if (part.type === 'field') {
        if (part.fieldname === 'action') action = String(part.value);
        continue;
      }
      const file = part.fieldname;
      if (file !== 'categories' && file !== 'questions') { part.file.resume(); continue; }
      const mediaType = part.mimetype.split(';')[0].trim().toLowerCase();
      const bytes = await part.toBuffer();
      if (!importMediaTypes.includes(mediaType)) badFile(file, `The ${file} file must be a CSV file.`, 'not_allowed');
      if (bytes.includes(0)) badFile(file, `The ${file} file is not a text file.`);
      try {
        files[file] = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        badFile(file, `The ${file} file is not UTF-8 text.`);
      }
    }
  } catch (error) {
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new HttpError(413, 'file_too_large', `Each file may be at most ${maxImportFileBytes} bytes.`, { params: { maxBytes: maxImportFileBytes } });
    }
    throw error;
  }
  if (action !== 'preview' && action !== 'import') {
    throw new HttpError(400, 'validation_failed', 'action must be preview or import.', { fields: [fieldError('action', 'not_allowed', 'action must be preview or import.')] });
  }
  if (files.categories === undefined && files.questions === undefined) throw new HttpError(400, 'file_required', 'Choose the categories file, the questions file, or both.');
  return { action, files };
}

interface Plan {
  categories: SheetCategory[];
  /** Each question with the name of its category, as the database or the file spells it. */
  questions: SheetQuestion[];
  skippedCategories: number;
  skippedQuestions: number;
  problems: FieldError[];
}

export class SheetImportService {
  constructor(private readonly context: AppContext) {}

  /** What an import would do: the categories and questions to create, what already exists, and every bad row. */
  private plan(files: ImportUpload['files']): Plan {
    const db = this.context.db;
    const sheetCategories = files.categories === undefined ? { categories: [], problems: [] } : readCategories(files.categories);
    const sheetQuestions = files.questions === undefined ? { questions: [], problems: [] } : readQuestions(files.questions);
    const problems = [...sheetCategories.problems, ...sheetQuestions.problems];
    const existing = listCategories(db);

    // Categories are matched by name; an existing one is left as it is.
    const categories: SheetCategory[] = [];
    let skippedCategories = 0;
    for (const category of sheetCategories.categories) {
      if (existing.some((other) => sameText(other.name, category.name))) { skippedCategories += 1; continue; }
      if (existing.some((other) => sameText(other.shortName, category.shortName))) {
        problems.push(fieldError('categories', 'duplicate', `categories.csv row ${category.row}, catNameShort: Another category already uses this short name.`, { row: category.row, column: 'catNameShort' }));
        continue;
      }
      categories.push(category);
    }

    // Questions belong to an existing category or one the file creates; one already there (same category and text) is skipped.
    const questions: SheetQuestion[] = [];
    let skippedQuestions = 0;
    for (const question of sheetQuestions.questions) {
      const inDatabase = existing.find((category) => sameText(category.name, question.category));
      const inFile = categories.find((category) => sameText(category.name, question.category));
      if (!inDatabase && !inFile) {
        problems.push(fieldError('questions', 'not_allowed', `questions.csv row ${question.row}, category: There is no category "${question.category}".`, { row: question.row, column: 'category', value: question.category }));
        continue;
      }
      const repeated = questions.some((other) => sameText(other.category, question.category) && sameText(other.prompt, question.prompt));
      if (repeated || (inDatabase && promptTaken(db, inDatabase.id, question.prompt, null))) { skippedQuestions += 1; continue; }
      questions.push(question);
    }
    problems.sort((first, second) => (first.field === second.field ? Number(first.params?.row) - Number(second.params?.row) : first.field === 'categories' ? -1 : 1));
    return { categories, questions, skippedCategories, skippedQuestions, problems };
  }

  private report(plan: Plan, action: ImportUpload['action'], imported: boolean): ImportReport {
    const approved = plan.questions.filter((question) => question.approved).length;
    return {
      action,
      imported,
      categories: { create: plan.categories.length, skip: plan.skippedCategories },
      questions: { create: plan.questions.length, skip: plan.skippedQuestions, approved, pending: plan.questions.length - approved },
      problems: plan.problems,
    };
  }

  preview(files: ImportUpload['files']): ImportReport {
    return this.report(this.plan(files), 'preview', false);
  }

  /** Writes the plan in one transaction, inside the route's data write (BAK-8); refuses a file with any bad row. */
  import(files: ImportUpload['files']): ImportReport {
    const plan = this.plan(files);
    if (plan.problems.length) throw new HttpError(400, 'validation_failed', 'The files have rows that cannot be imported; preview them for the details.', { fields: plan.problems });
    const db = this.context.db;
    db.transaction(() => {
      const ids = new Map(listCategories(db).map((category) => [category.name.toLowerCase(), category.id]));
      for (const { name, shortName, description, priority } of plan.categories) {
        ids.set(name.toLowerCase(), insertCategory(db, { name, shortName, description, priority }).id);
      }
      for (const question of plan.questions) {
        const categoryId = [...ids].find(([name]) => sameText(name, question.category))![1];
        insertQuestion(db, {
          categoryId,
          prompt: question.prompt,
          choices: question.choices,
          authorCredit: question.authorCredit,
          reviewNote: question.reviewNote,
          status: question.approved ? 'approved' : 'pending',
          createdBy: null,
        });
      }
    });
    return this.report(plan, 'import', true);
  }
}
