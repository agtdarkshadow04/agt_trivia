import type { MemberQuestion, MemberSession, QuestionBody, QuestionCounts } from '../src/lib/api.js';
import { isUuidV4, roleAtLeast } from '../src/lib/api.js';
import { fieldError, type FieldError } from '../src/lib/errors.js';
import { canAuthor, canChangeCredit, canReadQuestion, defaultCredit, questionPermission, statusAfterEdit, type QuestionAction } from '../src/lib/questionRules.js';
import { errorsOf, normalizeQuestion, questionErrors, questionLimits, questionNotices, questionStatuses, reviewNoteError, sameText, type QuestionStatus } from '../src/lib/validation.js';
import type { AppContext } from './context.js';
import { HttpError } from './http.js';
import { getCategory } from './repository/categories.js';
import * as repo from './repository/questions.js';

/**
 * Question authoring and review (#19): Editors write questions and submit
 * them, Moderators approve, reject, change, unpublish and delete them. The
 * rules are `src/lib/questionRules.ts`, shared with the member UI. Every
 * change carries the question's `version` (`409 conflict` when it has
 * changed); handlers run inside the route's data write (BAK-8).
 */

export interface QuestionListQuery {
  limit?: number;
  cursor?: string;
  status?: QuestionStatus;
  categoryId?: string;
  mine?: boolean;
  q?: string;
}

export interface QuestionChange<T> {
  question: T;
  /** The names of the fields that changed, for the audit summary (LOG-14). */
  changed: string[];
}

function notFound(): never {
  throw new HttpError(404, 'not_found', 'No such question.');
}

function forbidden(): never {
  throw new HttpError(403, 'forbidden', 'Your role does not allow this.');
}

function conflict(): never {
  throw new HttpError(409, 'conflict', 'The question has changed since it was read. Reload it and try again.');
}

export function encodeQuestionCursor(position: repo.QuestionPagePosition) {
  return Buffer.from(JSON.stringify([position.createdAt, position.id]), 'utf8').toString('base64url');
}

export function decodeQuestionCursor(cursor: string): repo.QuestionPagePosition | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && isUuidV4(value[1])) return { createdAt: value[0], id: value[1] };
  } catch {
    // An unreadable cursor is the same as a wrong one.
  }
  return null;
}

export class QuestionService {
  constructor(private readonly context: AppContext, private readonly member: MemberSession, private readonly now: () => Date = () => new Date()) {}

  private get db() {
    return this.context.db;
  }

  /** Players have no part in authoring (`403 forbidden`). */
  private requireAuthor() {
    if (!canAuthor(this.member.role)) forbidden();
  }

  private get moderator() {
    return roleAtLeast(this.member.role, 'Moderator');
  }

  private toMemberQuestions(questions: repo.Question[]): MemberQuestion[] {
    const names = repo.memberNames(this.db, questions.flatMap((question) => question.createdBy ? [question.createdBy] : []));
    return questions.map((question) => ({
      id: question.id,
      categoryId: question.categoryId,
      prompt: question.prompt,
      status: question.status,
      choices: question.choices.map((choice) => ({ id: choice.id, text: choice.text, isCorrect: choice.isCorrect })),
      authorCredit: question.authorCredit,
      reviewNote: question.reviewNote,
      createdBy: question.createdBy,
      createdByName: question.createdBy ? names.get(question.createdBy) ?? null : null,
      approvedAt: question.approvedAt,
      version: question.version,
      createdAt: question.createdAt,
      updatedAt: question.updatedAt,
    }));
  }

  private toMemberQuestion(question: repo.Question) {
    return this.toMemberQuestions([question])[0];
  }

  /** A question the member may see; others' questions answer 404 for Editors, so they do not learn they exist. */
  private readable(id: string): repo.Question {
    this.requireAuthor();
    const question = isUuidV4(id) ? repo.getQuestion(this.db, id.toLowerCase()) : null;
    if (!question || !canReadQuestion(this.member, question)) notFound();
    return question;
  }

  /** A question the member may take `action` on, at `version`. */
  private actionable(id: string, version: number, action: QuestionAction): repo.Question {
    const question = this.readable(id);
    if (question.version !== version) conflict();
    const permission = questionPermission(this.member, question, action);
    if (permission === 'forbidden') forbidden();
    if (permission === 'wrong_status') {
      throw new HttpError(409, 'conflict', `The question is ${question.status}; it cannot be changed that way. Reload it and try again.`);
    }
    return question;
  }

  /** Moderators list every question (`mine` narrows it to their own); Editors only ever their own. */
  list(query: QuestionListQuery) {
    this.requireAuthor();
    const after = query.cursor ? decodeQuestionCursor(query.cursor) : null;
    if (query.cursor && !after) throw new HttpError(400, 'invalid_request', 'The cursor is not valid.');
    const categoryId = query.categoryId ? query.categoryId.toLowerCase() : null;
    if (categoryId && !isUuidV4(categoryId)) throw new HttpError(400, 'invalid_request', 'categoryId must be a category ID.');
    const page = repo.listQuestions(this.db, {
      limit: query.limit ?? 50,
      after,
      status: query.status ?? null,
      categoryId,
      createdBy: this.moderator && !query.mine ? null : this.member.id,
      search: (query.q ?? '').trim(),
    });
    const last = page.questions.at(-1);
    return { items: this.toMemberQuestions(page.questions), nextCursor: page.more && last ? encodeQuestionCursor({ createdAt: last.createdAt, id: last.id }) : null };
  }

  counts(): QuestionCounts {
    this.requireAuthor();
    return { mine: repo.questionCounts(this.db, this.member.id), reviewQueue: this.moderator ? repo.questionCounts(this.db, null).pending : null };
  }

  get(id: string): MemberQuestion {
    return this.toMemberQuestion(this.readable(id));
  }

  /**
   * The checked, normalized content of a new or changed question, and its
   * notices (API-2): a long prompt, and a prompt the category already has.
   * `currentCredit` is the credit an Editor keeps: their display name for a
   * new question, the question's own when it changes.
   */
  private content(body: QuestionBody, currentCredit: string | null, exceptId: string | null): { content: repo.QuestionContent; notices: FieldError[] } {
    const mayChangeCredit = canChangeCredit(this.member.role);
    const credit = body.authorCredit === undefined ? currentCredit : body.authorCredit;
    const problems = questionErrors({ prompt: body.prompt, choices: body.choices, authorCredit: credit });
    const categoryId = body.categoryId.trim().toLowerCase();
    const category = isUuidV4(categoryId) ? getCategory(this.db, categoryId) : null;
    if (!category) problems.unshift(fieldError('categoryId', body.categoryId.trim() ? 'not_allowed' : 'required', 'Choose an existing category.'));
    if (!mayChangeCredit && body.authorCredit !== undefined && !sameText(body.authorCredit ?? '', currentCredit ?? '')) {
      problems.push(fieldError('authorCredit', 'not_allowed', 'Only Moderators can change the credit.'));
    }
    if (problems.length) throw new HttpError(400, 'validation_failed', 'The question is not valid.', { fields: problems });
    const normalized = normalizeQuestion({ prompt: body.prompt, choices: body.choices, authorCredit: mayChangeCredit ? credit : currentCredit });
    const notices = questionNotices(normalized);
    if (repo.promptTaken(this.db, category!.id, normalized.prompt, exceptId)) {
      notices.push(fieldError('prompt', 'duplicate', 'The category already has a question with this text.'));
    }
    return { content: { categoryId: category!.id, prompt: normalized.prompt, choices: normalized.choices, authorCredit: normalized.authorCredit }, notices };
  }

  /** A new question, always a draft; its author submits it when it is ready. */
  create(body: QuestionBody) {
    this.requireAuthor();
    const { content, notices } = this.content(body, defaultCredit(this.member.displayName, questionLimits.authorCredit.max), null);
    const question = repo.insertQuestion(this.db, { ...content, reviewNote: '', status: 'draft', createdBy: this.member.id }, this.now());
    return { question: this.toMemberQuestion(question), notices };
  }

  /** Replaces a question's content; a rejected one becomes a draft again, any other keeps its status. */
  replace(id: string, body: QuestionBody & { version: number }) {
    const current = this.actionable(id, body.version, 'edit');
    const { content, notices } = this.content(body, current.authorCredit, current.id);
    const status = statusAfterEdit(current.status);
    if (!repo.replaceQuestion(this.db, current.id, current.version, content, status, this.member.id, this.now())) conflict();
    const question = repo.getQuestion(this.db, current.id)!;
    return { question: this.toMemberQuestion(question), notices, changed: changedFields(current, question) };
  }

  delete(id: string, version: number) {
    const question = this.actionable(id, version, 'delete');
    if (!repo.deleteQuestion(this.db, question.id, version)) conflict();
    return question;
  }

  private changeStatus(id: string, version: number, action: Exclude<QuestionAction, 'edit' | 'delete'>, reviewNote?: string): QuestionChange<MemberQuestion> & { from: QuestionStatus } {
    const current = this.actionable(id, version, action);
    const at = this.now();
    const change: repo.StatusChange = {
      submit: { status: 'pending' as const, approvedBy: null, approvedAt: null, reviewNote: current.reviewNote },
      approve: { status: 'approved' as const, approvedBy: this.member.id, approvedAt: at.toISOString(), reviewNote: '' },
      reject: { status: 'rejected' as const, approvedBy: null, approvedAt: null, reviewNote: reviewNote ?? '' },
      unpublish: { status: 'draft' as const, approvedBy: null, approvedAt: null, reviewNote: current.reviewNote },
    }[action];
    if (!repo.changeQuestionStatus(this.db, current.id, version, current.status, change, this.member.id, at)) conflict();
    const question = repo.getQuestion(this.db, current.id)!;
    return { question: this.toMemberQuestion(question), from: current.status, changed: changedFields(current, question) };
  }

  /** draft or rejected → pending: ready for review. */
  submit(id: string, version: number) {
    return this.changeStatus(id, version, 'submit');
  }

  /** pending → approved: in the public quiz from now on. */
  approve(id: string, version: number) {
    return this.changeStatus(id, version, 'approve');
  }

  /** pending → rejected, with the reason the author sees. */
  reject(id: string, version: number, reviewNote: string) {
    const problems = errorsOf(reviewNoteError(reviewNote));
    if (problems.length) throw new HttpError(400, 'validation_failed', 'The review note is not valid.', { fields: problems });
    return this.changeStatus(id, version, 'reject', reviewNote.trim());
  }

  /** approved → draft: out of the public quiz until it is approved again. */
  unpublish(id: string, version: number) {
    return this.changeStatus(id, version, 'unpublish');
  }
}

/** The names of the fields that differ between two versions of a question, never their values (LOG-14). */
export function changedFields(before: repo.Question, after: repo.Question): string[] {
  const changed: string[] = [];
  if (before.categoryId !== after.categoryId) changed.push('categoryId');
  if (before.prompt !== after.prompt) changed.push('prompt');
  if (JSON.stringify(before.choices.map(({ text, isCorrect }) => [text, isCorrect])) !== JSON.stringify(after.choices.map(({ text, isCorrect }) => [text, isCorrect]))) changed.push('choices');
  if (before.authorCredit !== after.authorCredit) changed.push('authorCredit');
  if (before.status !== after.status) changed.push('status');
  if (before.reviewNote !== after.reviewNote) changed.push('reviewNote');
  return changed;
}

export function isQuestionStatus(value: string): value is QuestionStatus {
  return (questionStatuses as readonly string[]).includes(value);
}
