import type { MemberQuestion, QuestionBody } from './api.js';
import { fieldError, type FieldError } from './errors.js';
import { questionErrors, questionLimits } from './validation.js';

/**
 * The question form's state (#19): what the member typed, turned into the
 * request body and checked with the server's own validators (FE-6).
 */

export interface QuestionDraft {
  categoryId: string;
  prompt: string;
  choices: { text: string; isCorrect: boolean }[];
  authorCredit: string;
}

/** A new question: no category yet, two empty answers, the first one correct. */
export function emptyDraft(categoryId = '', authorCredit = ''): QuestionDraft {
  return { categoryId, prompt: '', choices: [{ text: '', isCorrect: true }, { text: '', isCorrect: false }], authorCredit };
}

export function draftFromQuestion(question: MemberQuestion): QuestionDraft {
  return {
    categoryId: question.categoryId,
    prompt: question.prompt,
    choices: question.choices.map(({ text, isCorrect }) => ({ text, isCorrect })),
    authorCredit: question.authorCredit ?? '',
  };
}

/** The request body; the credit only when the member may change it (Moderators). */
export function draftBody(draft: QuestionDraft, withCredit: boolean): QuestionBody {
  return {
    categoryId: draft.categoryId,
    prompt: draft.prompt,
    choices: draft.choices.map(({ text, isCorrect }) => ({ text, isCorrect })),
    ...(withCredit ? { authorCredit: draft.authorCredit } : {}),
  };
}

/** The field errors the server would answer with, so the form shows them before sending. */
export function draftErrors(draft: QuestionDraft, withCredit: boolean): FieldError[] {
  const errors = questionErrors({ prompt: draft.prompt, choices: draft.choices, authorCredit: withCredit ? draft.authorCredit : null });
  return draft.categoryId ? errors : [fieldError('categoryId', 'required', 'Choose a category.'), ...errors];
}

export function canAddChoice(draft: QuestionDraft) {
  return draft.choices.length < questionLimits.choices.max;
}

export function canRemoveChoice(draft: QuestionDraft) {
  return draft.choices.length > questionLimits.choices.min;
}

/** A, B, C, D: the letters players see before the answers. */
export function choiceLetter(index: number) {
  return String.fromCharCode(65 + index);
}
