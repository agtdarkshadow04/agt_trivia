import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MemberQuestion } from './api.js';
import { allowedQuestionActions, questionPermission, statusAfterEdit, defaultCredit } from './questionRules.js';
import { canAddChoice, canRemoveChoice, choiceLetter, draftBody, draftErrors, draftFromQuestion, emptyDraft } from './questionForm.js';

describe('the question form (#19)', () => {
  it('starts with two answers, the first correct, and checks the draft like the server', () => {
    const draft = emptyDraft();
    assert.equal(draft.choices.length, 2);
    assert.deepEqual(draftErrors(draft, false).map((error) => [error.field, error.code]), [
      ['categoryId', 'required'], ['prompt', 'required'], ['choices.0', 'required'], ['choices.1', 'required'],
    ]);
    const filled = { ...draft, categoryId: 'c', prompt: 'Why?', choices: [{ text: 'A', isCorrect: false }, { text: 'B', isCorrect: false }] };
    assert.deepEqual(draftErrors(filled, false).map((error) => error.code), ['correct_choice_required']);
    assert.equal(canRemoveChoice(filled), false);
    assert.equal(canAddChoice(filled), true);
    assert.equal(canAddChoice({ ...filled, choices: [...filled.choices, ...filled.choices] }), false);
    assert.equal(choiceLetter(3), 'D');
  });

  it('sends the credit only for Moderators', () => {
    const draft = { ...emptyDraft('c', 'Ada'), prompt: 'Q?' };
    assert.equal('authorCredit' in draftBody(draft, false), false);
    assert.equal(draftBody(draft, true).authorCredit, 'Ada');
    assert.deepEqual(draftErrors({ ...draft, authorCredit: 'x'.repeat(65), choices: [{ text: 'A', isCorrect: true }, { text: 'B', isCorrect: false }] }, true).map((error) => error.field), ['authorCredit']);
  });

  it('reads a question back into a draft', () => {
    const question = { categoryId: 'c', prompt: 'P', choices: [{ id: 'x', text: 'A', isCorrect: true }], authorCredit: null } as unknown as MemberQuestion;
    assert.deepEqual(draftFromQuestion(question), { categoryId: 'c', prompt: 'P', choices: [{ text: 'A', isCorrect: true }], authorCredit: '' });
  });
});

describe('who may do what with a question (#19)', () => {
  const editor = { id: 'e', role: 'Editor' as const };
  const moderator = { id: 'm', role: 'Moderator' as const };
  const player = { id: 'p', role: 'Player' as const };

  it('lets Editors work on their own questions until they are approved', () => {
    assert.deepEqual(allowedQuestionActions(editor, { status: 'draft', createdBy: 'e' }), ['submit', 'edit', 'delete']);
    assert.deepEqual(allowedQuestionActions(editor, { status: 'pending', createdBy: 'e' }), ['edit', 'delete']);
    assert.deepEqual(allowedQuestionActions(editor, { status: 'rejected', createdBy: 'e' }), ['submit', 'edit', 'delete']);
    assert.deepEqual(allowedQuestionActions(editor, { status: 'approved', createdBy: 'e' }), []);
    assert.equal(questionPermission(editor, { status: 'approved', createdBy: 'e' }, 'edit'), 'forbidden');
    assert.deepEqual(allowedQuestionActions(editor, { status: 'draft', createdBy: 'other' }), []);
    assert.deepEqual(allowedQuestionActions(player, { status: 'draft', createdBy: 'p' }), []);
  });

  it('lets Moderators review and change any question', () => {
    assert.deepEqual(allowedQuestionActions(moderator, { status: 'pending', createdBy: 'm' }), ['approve', 'reject', 'edit', 'delete']);
    assert.deepEqual(allowedQuestionActions(moderator, { status: 'approved', createdBy: null }), ['unpublish', 'edit', 'delete']);
    assert.equal(questionPermission(moderator, { status: 'draft', createdBy: 'e' }, 'approve'), 'wrong_status');
  });

  it('makes a changed rejected question a draft, and defaults the credit to the display name', () => {
    assert.equal(statusAfterEdit('rejected'), 'draft');
    assert.equal(statusAfterEdit('approved'), 'approved');
    assert.equal(defaultCredit('  Ada  ', 64), 'Ada');
    assert.equal(defaultCredit('é'.repeat(70), 64), 'é'.repeat(64));
  });
});
