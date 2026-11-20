import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isUuidV4, roleAtLeast } from './api.js';
import {
  adminUsernameError, categoryErrors, displayNameError, memberUsernameError, normalizeMemberUsername, confirmationError, errorsOf, newPasswordError, normalizeCategory, normalizeQuestion,
  questionErrors, questionNotices, quizLengthsError, requiredError, type CategoryInput, type QuestionInput,
  normalizeReport, reportInputErrors, resolutionNoteError,
} from './validation.js';

describe('shared validators', () => {
  it('requires a long quiz longer than a short one', () => {
    assert.equal(quizLengthsError(10, 30), null);
    assert.equal(quizLengthsError(10, 11), null);
    assert.deepEqual(quizLengthsError(10, 10), {
      field: 'quiz.longLength', code: 'out_of_range', message: 'quiz.longLength must be greater than quiz.shortLength (10).', params: { min: 11 },
    });
    assert.equal(quizLengthsError(30, 10)?.code, 'out_of_range');
  });

  it('accepts only UUIDv4 IDs (DATA-6, API-5)', () => {
    assert.equal(isUuidV4('3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e'), true);
    assert.equal(isUuidV4('3F2B8C1E-4D5A-4B6C-8D7E-9F0A1B2C3D4E'), true);
    assert.equal(isUuidV4('3f2b8c1e-4d5a-1b6c-8d7e-9f0a1b2c3d4e'), false, 'version 1');
    assert.equal(isUuidV4('3f2b8c1e-4d5a-4b6c-7d7e-9f0a1b2c3d4e'), false, 'wrong variant');
    assert.equal(isUuidV4('not-a-uuid'), false);
    assert.equal(isUuidV4(42), false);
  });

  it('checks the Admin username after trimming, counting code points (AUTH-3)', () => {
    assert.equal(adminUsernameError(' keeper '), null);
    assert.equal(adminUsernameError('   ')?.code, 'required');
    assert.equal(adminUsernameError('x'.repeat(64)), null);
    assert.deepEqual(adminUsernameError('x'.repeat(65))?.params, { max: 64 });
    assert.equal(adminUsernameError('🚀'.repeat(64)), null, 'emoji count once each');
  });

  it('requires new passwords of 12 to 1024 characters (AUTH-3)', () => {
    assert.equal(newPasswordError('a'.repeat(12)), null);
    assert.deepEqual(newPasswordError('a'.repeat(11)), { field: 'password', code: 'too_short', message: 'The password must be at least 12 characters.', params: { min: 12 } });
    assert.equal(newPasswordError('')?.code, 'required');
    assert.equal(newPasswordError('a'.repeat(1025))?.code, 'too_long');
    assert.equal(newPasswordError('🔑'.repeat(12)), null);
  });

  it('checks the confirmation and required fields, and collects the failures', () => {
    assert.equal(confirmationError('same', 'same'), null);
    assert.deepEqual(confirmationError('one', 'two'), { field: 'passwordConfirmation', code: 'mismatch', message: 'The passwords do not match.', params: { other: 'password' } });
    assert.equal(requiredError('username', '')?.code, 'required');
    assert.deepEqual(errorsOf(null, requiredError('a', ''), null).map((error) => error.field), ['a']);
  });
});

describe('category and question validators (#15, FE-6)', () => {
  const category: CategoryInput = { shortName: 'space-1', name: 'Space', description: 'About space.', priority: 10 };
  const codes = (errors: { field: string; code: string }[]) => errors.map((error) => `${error.field}:${error.code}`);

  it('accepts a valid category and trims it', () => {
    assert.deepEqual(categoryErrors(category), []);
    assert.deepEqual(normalizeCategory({ ...category, name: '  Space  ', shortName: ' space-1 ' }), category);
    assert.deepEqual(categoryErrors({ ...category, priority: 0 }), []);
    assert.deepEqual(categoryErrors({ ...category, priority: 100, shortName: 'a'.repeat(16) }), []);
  });

  it('checks every category field', () => {
    assert.deepEqual(codes(categoryErrors({ shortName: ' ', name: '', description: '  ', priority: -1 })), [
      'shortName:required', 'name:required', 'description:required', 'priority:out_of_range',
    ]);
    assert.deepEqual(codes(categoryErrors({ ...category, shortName: 'space one' })), ['shortName:invalid_format']);
    assert.deepEqual(codes(categoryErrors({ ...category, shortName: 'ünïcode' })), ['shortName:invalid_format']);
    assert.deepEqual(codes(categoryErrors({ ...category, shortName: 'a'.repeat(17) })), ['shortName:too_long']);
    assert.deepEqual(codes(categoryErrors({ ...category, name: 'n'.repeat(101), description: 'd'.repeat(301) })), ['name:too_long', 'description:too_long']);
    assert.deepEqual(codes(categoryErrors({ ...category, priority: 101 })), ['priority:out_of_range']);
    assert.deepEqual(codes(categoryErrors({ ...category, priority: 1.5 })), ['priority:out_of_range']);
    // Limits count code points, not UTF-16 units.
    assert.deepEqual(categoryErrors({ ...category, name: '🚀'.repeat(100) }), []);
  });

  const question: QuestionInput = {
    prompt: 'Which planet is largest?',
    choices: [{ text: 'Jupiter', isCorrect: true }, { text: 'Mars', isCorrect: false }],
    authorCredit: null,
  };

  it('accepts a valid question, multi-answer and commas included', () => {
    assert.deepEqual(questionErrors(question), []);
    assert.deepEqual(questionErrors({
      ...question,
      choices: [{ text: 'Red, hot', isCorrect: true }, { text: 'Blue', isCorrect: true }, { text: 'Green', isCorrect: false }, { text: 'Grey', isCorrect: false }],
      authorCredit: 'Traveller',
      reviewNote: 'Checked.',
    }), []);
  });

  it('normalizes a question: trims texts, an empty credit is null, no review note is empty', () => {
    assert.deepEqual(normalizeQuestion({ prompt: ' Why? ', choices: [{ text: ' A ', isCorrect: true }], authorCredit: '  ' }), {
      prompt: 'Why?', choices: [{ text: 'A', isCorrect: true }], authorCredit: null, reviewNote: '',
    });
  });

  it('needs 2 to 4 distinct answers, at least one correct', () => {
    assert.deepEqual(codes(questionErrors({ ...question, choices: [{ text: 'Only', isCorrect: true }] })), ['choices:too_few']);
    const five = ['A', 'B', 'C', 'D', 'E'].map((text) => ({ text, isCorrect: text === 'A' }));
    assert.deepEqual(codes(questionErrors({ ...question, choices: five })), ['choices:too_many']);
    assert.deepEqual(codes(questionErrors({ ...question, choices: question.choices.map((choice) => ({ ...choice, isCorrect: false })) })), ['choices:correct_choice_required']);
    assert.deepEqual(codes(questionErrors({ ...question, choices: [{ text: 'Mars', isCorrect: true }, { text: ' MARS ', isCorrect: false }] })), ['choices.1:duplicate']);
    assert.deepEqual(codes(questionErrors({ ...question, choices: [{ text: 'Mars', isCorrect: true }, { text: ' ', isCorrect: false }] })), ['choices.1:required']);
    assert.deepEqual(codes(questionErrors({ ...question, choices: [{ text: 'x'.repeat(201), isCorrect: true }, { text: 'B', isCorrect: false }] })), ['choices.0:too_long']);
  });

  it('checks the prompt, the credit and the review note', () => {
    assert.deepEqual(codes(questionErrors({ ...question, prompt: ' ' })), ['prompt:required']);
    assert.deepEqual(codes(questionErrors({ ...question, prompt: 'p'.repeat(301) })), ['prompt:too_long']);
    assert.deepEqual(codes(questionErrors({ ...question, authorCredit: 'c'.repeat(65), reviewNote: 'n'.repeat(1001) })), ['authorCredit:too_long', 'reviewNote:too_long']);
    assert.deepEqual(questionErrors({ ...question, authorCredit: '', reviewNote: '' }), []);
  });

  it('notices a prompt longer than 15 words without refusing it (API-2)', () => {
    assert.deepEqual(questionNotices({ prompt: Array(15).fill('word').join(' ') }), []);
    const long = Array(16).fill('word').join('  ');
    assert.deepEqual(questionNotices({ prompt: long }).map((notice) => [notice.field, notice.code, notice.params]), [['prompt', 'too_many_words', { max: 15, count: 16 }]]);
    assert.deepEqual(questionErrors({ ...question, prompt: long }), []);
  });
});

describe('member accounts (#17)', () => {
  it('ranks the roles: each has every power of the ones before it', () => {
    assert.equal(roleAtLeast('Player', 'Player'), true);
    assert.equal(roleAtLeast('Player', 'Editor'), false);
    assert.equal(roleAtLeast('Editor', 'Player'), true);
    assert.equal(roleAtLeast('Editor', 'Moderator'), false);
    assert.equal(roleAtLeast('Moderator', 'Editor'), true);
    assert.equal(roleAtLeast('Moderator', 'Moderator'), true);
  });

  it('checks usernames after trimming and lowercasing', () => {
    assert.equal(normalizeMemberUsername('  Pilot.One '), 'pilot.one');
    assert.equal(memberUsernameError('  Pilot.One_2-x '), null);
    const code = (value: string) => memberUsernameError(value)?.code;
    assert.equal(code(' '), 'required');
    assert.equal(code('ab'), 'too_short');
    assert.equal(code('a'.repeat(65)), 'too_long');
    assert.equal(code('has space'), 'invalid_format');
    assert.equal(code('émile'), 'invalid_format');
  });

  it('checks display names after trimming, counting code points', () => {
    assert.equal(displayNameError('  Pilot  '), null);
    assert.equal(displayNameError(' ')?.code, 'required');
    assert.equal(displayNameError('🚀'.repeat(120)), null);
    assert.equal(displayNameError('x'.repeat(121))?.code, 'too_long');
  });
});

describe('question reports (#46)', () => {
  const codes = (input: { reason: string; note: string }) => reportInputErrors(input).map((error) => [error.field, error.code]);

  it('needs a known reason, and details only for "other"', () => {
    assert.deepEqual(codes({ reason: 'typo', note: '' }), []);
    assert.deepEqual(codes({ reason: '', note: '' }), [['reason', 'required']]);
    assert.deepEqual(codes({ reason: 'boring', note: '' }), [['reason', 'not_allowed']]);
    assert.deepEqual(codes({ reason: 'other', note: '  ' }), [['note', 'required']]);
    assert.deepEqual(codes({ reason: 'other', note: 'The image is missing.' }), []);
  });

  it('limits the notes to 500 characters, counted in code points, and trims the stored note', () => {
    assert.deepEqual(codes({ reason: 'unclear', note: '🚀'.repeat(500) }), []);
    assert.deepEqual(codes({ reason: 'unclear', note: 'x'.repeat(501) }), [['note', 'too_long']]);
    assert.equal(resolutionNoteError(''), null);
    assert.equal(resolutionNoteError('y'.repeat(501))?.code, 'too_long');
    assert.deepEqual(normalizeReport({ reason: 'typo', note: '  spaced  ' }), { reason: 'typo', note: 'spaced' });
  });
});
