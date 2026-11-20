import type { MemberSession, QuizLength } from '../src/lib/api.js';
import { isUuidV4 } from '../src/lib/api.js';
import { fieldError, type FieldError } from '../src/lib/errors.js';
import { isCorrectSelection } from '../src/lib/quiz.js';
import type { AppContext } from './context.js';
import { HttpError } from './http.js';
import { getCategory } from './repository/categories.js';
import { approvedQuestions, getQuestion } from './repository/questions.js';
import * as repo from './repository/results.js';

/**
 * Member score history (#21). A signed-in member's finished quiz is graded
 * here, against the category's approved questions as they are now; the
 * browser's own score is never trusted. Answers to questions that were
 * unapproved or deleted since the quiz started are left out and reported.
 * Every member sees only their own results.
 */

export interface SubmittedAnswer {
  questionId: string;
  choiceIds: string[];
}

export interface ResultSubmission {
  categoryId: string;
  length: QuizLength;
  answers: SubmittedAnswer[];
}

export interface MemberResult {
  id: string;
  categoryId: string | null;
  categoryName: string;
  length: QuizLength;
  score: number;
  total: number;
  /** 0 to 100, rounded. */
  percent: number;
  finishedAt: string;
}

export interface CategoryStats {
  categoryId: string;
  categoryName: string;
  plays: number;
  bestPercent: number;
  averagePercent: number;
  lastPlayedAt: string;
}

const percentOf = (score: number, total: number) => Math.round((score / total) * 100);

function toMemberResult(result: repo.StoredResult): MemberResult {
  const { id, categoryId, categoryName, length, score, total, finishedAt } = result;
  return { id, categoryId, categoryName, length, score, total, percent: percentOf(score, total), finishedAt };
}

export function encodeResultCursor(position: repo.ResultPagePosition) {
  return Buffer.from(JSON.stringify([position.finishedAt, position.id]), 'utf8').toString('base64url');
}

export function decodeResultCursor(cursor: string): repo.ResultPagePosition | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && isUuidV4(value[1])) return { finishedAt: value[0], id: value[1] };
  } catch {
    // An unreadable cursor is the same as a wrong one.
  }
  return null;
}

export class ResultService {
  constructor(private readonly context: AppContext, private readonly member: MemberSession, private readonly now: () => Date = () => new Date()) {}

  private get db() {
    return this.context.db;
  }

  /**
   * Grades and stores a finished quiz. Each question may be answered once, and
   * must belong to the category; at most as many answers as the category has
   * approved questions. Returns the stored result and the IDs of the questions
   * that were left out because they are no longer approved.
   */
  submit(submission: ResultSubmission) {
    const categoryId = submission.categoryId.toLowerCase();
    const category = isUuidV4(categoryId) ? getCategory(this.db, categoryId) : null;
    if (!category) throw new HttpError(404, 'not_found', 'No such category.');
    const approved = new Map(approvedQuestions(this.db, category.id).map((question) => [question.id, question]));
    const problems: FieldError[] = [];
    if (submission.answers.length === 0) problems.push(fieldError('answers', 'too_few', 'A result needs at least one answer.', { min: 1 }));
    if (submission.answers.length > Math.max(approved.size, 1)) {
      problems.push(fieldError('answers', 'too_many', `The category has ${approved.size} questions.`, { max: approved.size }));
    }
    const seen = new Set<string>();
    const graded: { questionId: string; correct: boolean }[] = [];
    const skipped: string[] = [];
    submission.answers.forEach((answer, index) => {
      const field = `answers.${index}`;
      const questionId = answer.questionId.toLowerCase();
      if (!isUuidV4(questionId)) { problems.push(fieldError(field, 'invalid_format', 'The question ID is not valid.')); return; }
      if (seen.has(questionId)) { problems.push(fieldError(field, 'duplicate', 'Each question is answered once.')); return; }
      seen.add(questionId);
      const question = approved.get(questionId);
      if (!question) {
        // Approved in another category is a wrong request; unapproved or deleted meanwhile is left out.
        const elsewhere = getQuestion(this.db, questionId);
        if (elsewhere && elsewhere.status === 'approved' && elsewhere.categoryId !== category.id) {
          problems.push(fieldError(field, 'not_allowed', 'The question belongs to another category.'));
        } else {
          skipped.push(questionId);
        }
        return;
      }
      const choiceIds = answer.choiceIds.map((id) => id.toLowerCase());
      if (new Set(choiceIds).size !== choiceIds.length) { problems.push(fieldError(field, 'duplicate', 'Each answer is chosen once.')); return; }
      if (choiceIds.some((id) => !question.choices.some((choice) => choice.id === id))) {
        problems.push(fieldError(field, 'not_allowed', 'An answer does not belong to the question.'));
        return;
      }
      graded.push({ questionId, correct: isCorrectSelection(choiceIds, question.choices.filter((choice) => choice.isCorrect).map((choice) => choice.id)) });
    });
    if (problems.length) throw new HttpError(400, 'validation_failed', 'The result is not valid.', { fields: problems });
    if (!graded.length) throw new HttpError(409, 'conflict', 'None of the questions is approved any more; nothing was saved.');
    const stored = repo.insertResult(this.db, {
      memberId: this.member.id, categoryId: category.id, categoryName: category.name, length: submission.length, answers: graded,
    }, this.now());
    return { result: toMemberResult(stored), skippedQuestionIds: skipped };
  }

  list(query: { categoryId?: string; limit?: number; cursor?: string }) {
    const after = query.cursor ? decodeResultCursor(query.cursor) : null;
    if (query.cursor && !after) throw new HttpError(400, 'invalid_request', 'The cursor is not valid.');
    const categoryId = query.categoryId ? query.categoryId.toLowerCase() : null;
    if (categoryId && !isUuidV4(categoryId)) throw new HttpError(400, 'invalid_request', 'categoryId must be a category ID.');
    const page = repo.listResults(this.db, { memberId: this.member.id, categoryId, limit: query.limit ?? 50, after });
    const last = page.results.at(-1);
    return { items: page.results.map(toMemberResult), nextCursor: page.more && last ? encodeResultCursor({ finishedAt: last.finishedAt, id: last.id }) : null };
  }

  stats(): CategoryStats[] {
    return repo.memberStats(this.db, this.member.id).map((row) => ({
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      plays: row.plays,
      bestPercent: Math.round(row.bestPercent),
      averagePercent: Math.round(row.averagePercent),
      lastPlayedAt: row.lastPlayedAt,
    }));
  }

  /** Clears the member's own history. */
  clear() {
    return repo.deleteMemberResults(this.db, this.member.id);
  }
}
