import { roleAtLeast, type MemberRole } from './api.js';
import type { QuestionStatus } from './validation.js';

/**
 * Who may do what with a question (#19), shared by the server, which enforces
 * it, and the member UI, which shows only the actions a member may take (UI
 * hiding is never access control).
 *
 * - Editors write questions (as drafts), and change, delete and submit their
 *   own until a Moderator approves them; approved questions are locked for them.
 * - Moderators review: they approve or reject pending questions, change any
 *   question (an approved one stays approved), unpublish approved ones back to
 *   drafts, delete any question, and may approve their own.
 * - Players have no part in authoring.
 */

export type QuestionAction = 'edit' | 'delete' | 'submit' | 'approve' | 'reject' | 'unpublish';
/** In the order the UI shows them: the next step first, Delete last. */
export const questionActions: readonly QuestionAction[] = ['submit', 'approve', 'reject', 'unpublish', 'edit', 'delete'];

export interface QuestionActor {
  id: string;
  role: MemberRole;
}

export interface QuestionOwnership {
  status: QuestionStatus;
  createdBy: string | null;
}

/** The statuses each action starts from. */
const fromStatuses: Record<QuestionAction, readonly QuestionStatus[]> = {
  edit: ['draft', 'pending', 'approved', 'rejected'],
  delete: ['draft', 'pending', 'approved', 'rejected'],
  submit: ['draft', 'rejected'],
  approve: ['pending'],
  reject: ['pending'],
  unpublish: ['approved'],
};

/** Members who may write questions: Editors and Moderators. */
export function canAuthor(role: MemberRole) {
  return roleAtLeast(role, 'Editor');
}

/** Moderators may change the "Submitted by" credit; for Editors it is their display name. */
export function canChangeCredit(role: MemberRole) {
  return roleAtLeast(role, 'Moderator');
}

/** Moderators see every question, Editors their own. */
export function canReadQuestion(actor: QuestionActor, question: QuestionOwnership) {
  return roleAtLeast(actor.role, 'Moderator') || (canAuthor(actor.role) && question.createdBy === actor.id);
}

/**
 * Whether `actor` may take `action` on `question`: `forbidden` when their role
 * or ownership does not allow it, `wrong_status` when the question's status
 * does not (it may have changed since it was read).
 */
export function questionPermission(actor: QuestionActor, question: QuestionOwnership, action: QuestionAction): 'allowed' | 'forbidden' | 'wrong_status' {
  if (!canReadQuestion(actor, question)) return 'forbidden';
  const moderator = roleAtLeast(actor.role, 'Moderator');
  if (!moderator) {
    if (action === 'approve' || action === 'reject' || action === 'unpublish') return 'forbidden';
    if (question.status === 'approved') return 'forbidden';
  }
  return fromStatuses[action].includes(question.status) ? 'allowed' : 'wrong_status';
}

/** The actions `actor` may take on `question` now. */
export function allowedQuestionActions(actor: QuestionActor, question: QuestionOwnership): QuestionAction[] {
  return questionActions.filter((action) => questionPermission(actor, question, action) === 'allowed');
}

/**
 * The status after a change: editing a rejected question makes it a draft
 * again; any other status stays (an approved question a Moderator changes
 * stays approved).
 */
export function statusAfterEdit(status: QuestionStatus): QuestionStatus {
  return status === 'rejected' ? 'draft' : status;
}

/** The default "Submitted by" credit: the member's display name, cut to the credit's maximum length. */
export function defaultCredit(displayName: string, max: number) {
  return [...displayName.trim()].slice(0, max).join('').trim() || null;
}
