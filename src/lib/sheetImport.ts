import { CsvError, isEmptyRecord, parseCsv } from './csv.js';
import { fieldError, type FieldCode, type FieldError } from './errors.js';
import { categoryErrors, normalizeCategory, normalizeQuestion, questionErrors, sameText, type CategoryInput } from './validation.js';

/**
 * Reading the 1.x Google Sheet's CSV exports (#22): `validCategories` and
 * `pendingQuestions`, as Google Sheets downloads them. Every problem is a
 * `FieldError` whose `field` names the file (`categories` or `questions`) and
 * whose `params` give the sheet `row` (the header is row 1) and the `column`,
 * so the preview can say exactly where to look. Empty rows are skipped.
 */

export type ImportFile = 'categories' | 'questions';

/**
 * Checkbox columns: Google Sheets exports an unchecked box as FALSE on every
 * row of the sheet, the ~900 unused ones too, so they never make a row count
 * as filled.
 */
const checkboxColumns: readonly string[] = ['isApproved', 'isMultiAnswer'];

/** The columns each file needs; any others (`catTheme`, `adminNotes` of a category) are ignored. */
export const importColumns = {
  categories: ['catName', 'catNameShort', 'catDesc', 'catPriority'],
  questions: ['category', 'isApproved', 'adminNotes', 'isMultiAnswer', 'question', 'answers', 'correctAnswer', 'author'],
} as const;

export interface SheetCategory extends CategoryInput {
  row: number;
}

export interface SheetQuestion {
  row: number;
  /** The category's name, as in `validCategories.catName`. */
  category: string;
  approved: boolean;
  prompt: string;
  choices: { text: string; isCorrect: boolean }[];
  authorCredit: string | null;
  reviewNote: string;
}

function problem(file: ImportFile, row: number, column: string | null, code: FieldCode, message: string, params: Record<string, string | number> = {}): FieldError {
  const where = `${file}.csv row ${row}${column ? `, ${column}` : ''}`;
  return fieldError(file, code, `${where}: ${message}`, { row, ...(column ? { column } : {}), ...params });
}

/** The records of a file with a known header, or the problems that stop it being read at all. */
function readTable(file: ImportFile, text: string): { rows: { row: number; get(column: string): string }[]; problems: FieldError[] } {
  let records: string[][];
  try {
    records = parseCsv(text);
  } catch (error) {
    if (error instanceof CsvError) return { rows: [], problems: [problem(file, error.line, null, 'invalid_format', error.message)] };
    throw error;
  }
  const header = (records[0] ?? []).map((name) => name.trim());
  const missing = importColumns[file].filter((column) => !header.includes(column));
  if (missing.length) {
    return { rows: [], problems: missing.map((column) => problem(file, 1, column, 'required', `The column ${column} is missing.`)) };
  }
  const index = new Map(header.map((name, position) => [name, position]));
  const content = header.map((name, position) => (checkboxColumns.includes(name) ? -1 : position)).filter((position) => position >= 0);
  const rows = records.slice(1).flatMap((record, position) => (isEmptyRecord(content.map((column) => record[column] ?? ''))
    ? []
    : [{ row: position + 2, get: (column: string) => (record[index.get(column)!] ?? '').trim() }]));
  return { rows, problems: [] };
}

/** TRUE/FALSE as Google Sheets exports checkboxes, and the 1.x spellings true/false, yes/no, 1/0. */
function readBoolean(value: string): boolean | null {
  const normalized = value.toLowerCase();
  if (['true', 'yes', '1'].includes(normalized)) return true;
  if (['false', 'no', '0'].includes(normalized)) return false;
  return null;
}

/** An answer list: answers separated by commas, each trimmed ("A, B, C" and "2,3,4,5" alike). */
export function splitAnswers(value: string) {
  return value.split(',').map((answer) => answer.trim()).filter(Boolean);
}

/** Maps a shared validator's field (`name`, `choices.2`) to the sheet's column. */
function columnFor(file: ImportFile, field: string) {
  if (file === 'categories') return { shortName: 'catNameShort', name: 'catName', description: 'catDesc', priority: 'catPriority' }[field] ?? field;
  if (field === 'prompt') return 'question';
  if (field === 'authorCredit') return 'author';
  if (field === 'reviewNote') return 'adminNotes';
  return 'answers';
}

export function readCategories(text: string): { categories: SheetCategory[]; problems: FieldError[] } {
  const { rows, problems } = readTable('categories', text);
  const categories: SheetCategory[] = [];
  for (const { row, get } of rows) {
    const priorityText = get('catPriority');
    const input: CategoryInput = { name: get('catName'), shortName: get('catNameShort'), description: get('catDesc'), priority: priorityText === '' ? Number.NaN : Number(priorityText) };
    const errors = categoryErrors(input);
    for (const error of errors) problems.push(problem('categories', row, columnFor('categories', error.field), error.code as FieldCode, error.message, error.params as Record<string, number>));
    if (errors.length) continue;
    const category = normalizeCategory(input);
    const clash = categories.find((other) => sameText(other.name, category.name) || sameText(other.shortName, category.shortName));
    if (clash) {
      const column = sameText(clash.name, category.name) ? 'catName' : 'catNameShort';
      problems.push(problem('categories', row, column, 'duplicate', `Row ${clash.row} has the same ${column}.`, { otherRow: clash.row }));
      continue;
    }
    categories.push({ ...category, row });
  }
  return { categories, problems };
}

export function readQuestions(text: string): { questions: SheetQuestion[]; problems: FieldError[] } {
  const { rows, problems } = readTable('questions', text);
  const questions: SheetQuestion[] = [];
  for (const { row, get } of rows) {
    const rowProblems: FieldError[] = [];
    const add = (column: string | null, code: FieldCode, message: string, params?: Record<string, string | number>) => rowProblems.push(problem('questions', row, column, code, message, params));
    const category = get('category');
    if (!category) add('category', 'required', 'The category is required.');
    const approved = readBoolean(get('isApproved'));
    if (approved === null) add('isApproved', 'invalid_format', 'isApproved must be TRUE or FALSE.');
    const multiText = get('isMultiAnswer');
    const multi = multiText === '' ? null : readBoolean(multiText);
    if (multiText !== '' && multi === null) add('isMultiAnswer', 'invalid_format', 'isMultiAnswer must be TRUE or FALSE.');
    const answers = splitAnswers(get('answers'));
    const correct = splitAnswers(get('correctAnswer'));
    if (!correct.length) add('correctAnswer', 'required', 'The correct answer is required.');
    for (const answer of correct) {
      if (!answers.some((candidate) => sameText(candidate, answer))) add('correctAnswer', 'not_allowed', `"${answer}" is not one of the answers.`, { value: answer });
    }
    const choices = answers.map((text) => ({ text, isCorrect: correct.some((answer) => sameText(answer, text)) }));
    const input = { prompt: get('question'), choices, authorCredit: get('author'), reviewNote: get('adminNotes') };
    for (const error of questionErrors(input)) {
      // The answer check above already reports a correct answer that is missing.
      if (error.code === 'correct_choice_required' && correct.length) continue;
      add(columnFor('questions', error.field), error.code as FieldCode, error.message, error.params as Record<string, number>);
    }
    const correctCount = choices.filter((choice) => choice.isCorrect).length;
    if (multi !== null && correctCount > 0 && multi !== correctCount > 1) {
      add('isMultiAnswer', 'mismatch', multi ? 'isMultiAnswer is TRUE, but only one answer is correct.' : 'isMultiAnswer is FALSE, but more than one answer is correct.');
    }
    if (rowProblems.length) { problems.push(...rowProblems); continue; }
    const normalized = normalizeQuestion(input);
    questions.push({
      row,
      category,
      approved: approved!,
      prompt: normalized.prompt,
      choices: normalized.choices.map(({ text, isCorrect }) => ({ text, isCorrect })),
      authorCredit: normalized.authorCredit,
      reviewNote: normalized.reviewNote,
    });
  }
  return { questions, problems };
}
