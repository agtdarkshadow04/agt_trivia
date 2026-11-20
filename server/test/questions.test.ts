import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { AdminMember, MemberQuestion } from '../../src/lib/api.js';
import type { QuestionStatus } from '../../src/lib/validation.js';
import { buildApp } from '../app.js';
import { withDataWrite } from '../dataWrite.js';
import { publicQuiz } from '../quizRoutes.js';
import { insertCategory } from '../repository/categories.js';
import { getQuestion, insertQuestion } from '../repository/questions.js';
import { createMember, memberCookie, sampleQuestion, testContext } from './helpers.js';

/** Question authoring and review (#19): the role × action × status rules, concurrency, notices and the audit log. */

const csrf = { 'x-agt-request': '1' };
const statuses: QuestionStatus[] = ['draft', 'pending', 'approved', 'rejected'];
type Action = 'read' | 'edit' | 'delete' | 'submit' | 'approve' | 'reject' | 'unpublish';
const actions: Action[] = ['read', 'edit', 'delete', 'submit', 'approve', 'reject', 'unpublish'];

const body = (categoryId: string, prompt: string, extra: Record<string, unknown> = {}) => ({
  categoryId,
  prompt,
  choices: [{ text: 'Right', isCorrect: true }, { text: 'Wrong', isCorrect: false }],
  ...extra,
});

describe('question authoring and review', () => {
  const context = testContext();
  let app: FastifyInstance;
  let categoryId: string;
  let otherCategoryId: string;
  const members: Record<'player' | 'author' | 'editor' | 'moderator', { member: AdminMember; cookie: string }> = {} as never;

  before(async () => {
    app = buildApp(context);
    await app.ready();
    ({ id: categoryId } = await withDataWrite(context.operations, () => insertCategory(context.db, { shortName: 'space', name: 'Space', description: 'd', priority: 0 })));
    ({ id: otherCategoryId } = await withDataWrite(context.operations, () => insertCategory(context.db, { shortName: 'bio', name: 'Biology', description: 'd', priority: 0 })));
    for (const [key, role] of [['player', 'Player'], ['author', 'Editor'], ['editor', 'Editor'], ['moderator', 'Moderator']] as const) {
      const member = await createMember(context, `q.${key}`, role);
      members[key] = { member, cookie: await memberCookie(context, `q.${key}`) };
    }
  });
  after(async () => { await app.close(); context.close(); });

  let count = 0;
  /** A question the author wrote, with `status`. */
  const seed = (status: QuestionStatus, createdBy = members.author.member.id) => withDataWrite(context.operations, () => {
    count += 1;
    return insertQuestion(context.db, sampleQuestion(categoryId, `Seeded question ${count}`, { status, createdBy, reviewNote: status === 'rejected' ? 'Needs a source.' : '' }));
  });

  const as = (key: keyof typeof members, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({
    method,
    url,
    headers: { cookie: members[key].cookie, ...(method === 'GET' ? {} : csrf) },
    ...(payload ? { payload } : {}),
  });

  async function act(key: keyof typeof members, action: Action, id: string, version: number) {
    const url = `/api/member/questions/${id}`;
    switch (action) {
      case 'read': return as(key, 'GET', url);
      case 'edit': return as(key, 'PUT', url, body(categoryId, `Changed ${id}`, { version }));
      case 'delete': return as(key, 'DELETE', `${url}?version=${version}`);
      case 'reject': return as(key, 'POST', `${url}/reject`, { version, reviewNote: 'Not quite.' });
      default: return as(key, 'POST', `${url}/${action}`, { version });
    }
  }

  // The rules, written out by hand: what each member gets for each action on the author's question in each status.
  const ok = (action: Action) => (action === 'delete' ? 204 : 200);
  function expected(key: keyof typeof members, action: Action, status: QuestionStatus): number {
    if (key === 'player') return 403;
    if (key === 'editor') return 404;
    const from: Record<Exclude<Action, 'read'>, QuestionStatus[]> = {
      edit: statuses, delete: statuses, submit: ['draft', 'rejected'], approve: ['pending'], reject: ['pending'], unpublish: ['approved'],
    };
    if (action === 'read') return 200;
    if (key === 'author') {
      if (action === 'approve' || action === 'reject' || action === 'unpublish' || status === 'approved') return 403;
    }
    return from[action].includes(status) ? ok(action) : 409;
  }

  it('applies the rules for every role, action and status (#19)', async () => {
    for (const key of ['player', 'author', 'editor', 'moderator'] as const) {
      for (const status of statuses) {
        for (const action of actions) {
          const question = await seed(status);
          const response = await act(key, action, question.id, question.version);
          const want = expected(key, action, status);
          assert.equal(response.statusCode, want, `${key} ${action} ${status}: ${response.body}`);
          const stored = getQuestion(context.db, question.id);
          if (want >= 400) {
            assert.deepEqual(stored, question, `${key} ${action} ${status} changes nothing`);
            assert.equal(response.json().error, { 403: 'forbidden', 404: 'not_found', 409: 'conflict' }[want]);
          } else if (action === 'delete') {
            assert.equal(stored, null);
          } else if (action !== 'read') {
            const after = { edit: status === 'rejected' ? 'draft' : status, submit: 'pending', approve: 'approved', reject: 'rejected', unpublish: 'draft' }[action];
            assert.equal(stored!.status, after, `${key} ${action} ${status}`);
            assert.equal(stored!.version, question.version + 1);
            assert.equal(stored!.modifiedBy, members[key].member.id);
          }
        }
      }
    }
  });

  it('refuses a member without the CSRF header, and a visitor or the Admin cookie', async () => {
    const question = await seed('draft');
    const noCsrf = await app.inject({ method: 'POST', url: `/api/member/questions/${question.id}/submit`, headers: { cookie: members.author.cookie }, payload: { version: 1 } });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(noCsrf.json().error, 'csrf');
    const visitor = await app.inject({ url: '/api/member/questions' });
    assert.equal(visitor.statusCode, 401);
    assert.equal((await as('player', 'GET', '/api/member/questions')).statusCode, 403);
    assert.equal((await as('player', 'POST', '/api/member/questions', body(categoryId, 'Players cannot write?'))).statusCode, 403);
    assert.equal((await as('player', 'GET', '/api/member/question-counts')).statusCode, 403);
    assert.equal((await as('author', 'GET', '/api/member/questions/not-an-id')).statusCode, 404);
  });

  it('creates drafts with the author\'s display name as credit, which only Moderators can change', async () => {
    const created = await as('author', 'POST', '/api/member/questions', body(categoryId, '  Which planet has rings?  '));
    assert.equal(created.statusCode, 201);
    const { question, notices } = created.json() as { question: MemberQuestion; notices: unknown[] };
    assert.equal(question.status, 'draft');
    assert.equal(question.prompt, 'Which planet has rings?');
    assert.equal(question.authorCredit, 'Display q.author');
    assert.equal(question.createdBy, members.author.member.id);
    assert.equal(question.createdByName, 'Display q.author');
    assert.equal(question.version, 1);
    assert.deepEqual(notices, []);

    const same = await as('author', 'POST', '/api/member/questions', body(categoryId, 'Second?', { authorCredit: 'display Q.AUTHOR' }));
    assert.equal(same.statusCode, 201);
    assert.equal(same.json().question.authorCredit, 'Display q.author');
    const other = await as('author', 'POST', '/api/member/questions', body(categoryId, 'Third?', { authorCredit: 'Someone else' }));
    assert.equal(other.statusCode, 400);
    assert.deepEqual(other.json().fields.map((field: { field: string; code: string }) => [field.field, field.code]), [['authorCredit', 'not_allowed']]);
    const changed = await as('author', 'PUT', `/api/member/questions/${question.id}`, body(categoryId, 'Which planet has rings?', { version: 1, authorCredit: null }));
    assert.equal(changed.statusCode, 400);

    const moderated = await as('moderator', 'POST', '/api/member/questions', body(categoryId, 'Credited?', { authorCredit: 'Traveller Ada' }));
    assert.equal(moderated.json().question.authorCredit, 'Traveller Ada');
    const kept = await as('moderator', 'PUT', `/api/member/questions/${question.id}`, body(otherCategoryId, 'Which planet has rings?', { version: 1 }));
    assert.equal(kept.statusCode, 200);
    assert.equal(kept.json().question.authorCredit, 'Display q.author');
    const cleared = await as('moderator', 'PUT', `/api/member/questions/${question.id}`, body(otherCategoryId, 'Which planet has rings?', { version: 2, authorCredit: '' }));
    assert.equal(cleared.json().question.authorCredit, null);
  });

  it('checks questions with the shared validators, and gives notices for long and repeated prompts (API-2)', async () => {
    const invalid = await as('author', 'POST', '/api/member/questions', {
      categoryId: '00000000-0000-4000-8000-000000000000', prompt: ' ', choices: [{ text: 'Same', isCorrect: false }, { text: 'same', isCorrect: false }],
    });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.json().fields.map((field: { field: string; code: string }) => [field.field, field.code]), [
      ['categoryId', 'not_allowed'], ['prompt', 'required'], ['choices.1', 'duplicate'], ['choices', 'correct_choice_required'],
    ]);
    const shape = await as('author', 'POST', '/api/member/questions', { ...body(categoryId, 'Q?'), status: 'approved' });
    assert.equal(shape.statusCode, 400);
    assert.deepEqual(shape.json().fields.map((field: { field: string; code: string }) => [field.field, field.code]), [['status', 'not_allowed']]);

    const long = 'Which of these is the largest moon of the planet Saturn in our own solar system today?';
    await as('author', 'POST', '/api/member/questions', body(categoryId, 'Is Titan large?'));
    const noticed = await as('editor', 'POST', '/api/member/questions', body(categoryId, 'is titan LARGE?'));
    assert.deepEqual(noticed.json().notices.map((notice: { field: string; code: string }) => [notice.field, notice.code]), [['prompt', 'duplicate']]);
    const wordy = await as('editor', 'POST', '/api/member/questions', body(otherCategoryId, long));
    assert.equal(wordy.statusCode, 201);
    assert.deepEqual(wordy.json().notices.map((notice: { field: string; code: string; params: object }) => [notice.field, notice.code, notice.params]), [['prompt', 'too_many_words', { max: 15, count: 17 }]]);
    // A question is not its own duplicate.
    const { question } = wordy.json() as { question: MemberQuestion };
    const replaced = await as('editor', 'PUT', `/api/member/questions/${question.id}`, body(otherCategoryId, 'Is Titan the largest?', { version: 1 }));
    assert.deepEqual(replaced.json().notices, []);
  });

  it('requires a review note to reject, shows it to the author, and clears it on approval', async () => {
    const question = await seed('pending');
    const empty = await as('moderator', 'POST', `/api/member/questions/${question.id}/reject`, { version: 1, reviewNote: '  ' });
    assert.equal(empty.statusCode, 400);
    assert.deepEqual(empty.json().fields.map((field: { field: string; code: string }) => [field.field, field.code]), [['reviewNote', 'required']]);
    const rejected = await as('moderator', 'POST', `/api/member/questions/${question.id}/reject`, { version: 1, reviewNote: ' Please add a source. ' });
    assert.equal(rejected.json().reviewNote, 'Please add a source.');
    assert.equal((await as('author', 'GET', `/api/member/questions/${question.id}`)).json().reviewNote, 'Please add a source.');
    // The author changes it (a draft again) and submits it; the note stays until it is approved.
    const fixed = await as('author', 'PUT', `/api/member/questions/${question.id}`, body(categoryId, 'Fixed question?', { version: 2 }));
    assert.equal(fixed.json().question.status, 'draft');
    const submitted = await as('author', 'POST', `/api/member/questions/${question.id}/submit`, { version: 3 });
    assert.equal(submitted.json().status, 'pending');
    assert.equal(submitted.json().reviewNote, 'Please add a source.');
    const approved = await as('moderator', 'POST', `/api/member/questions/${question.id}/approve`, { version: 4 });
    assert.equal(approved.json().status, 'approved');
    assert.equal(approved.json().reviewNote, '');
    assert.ok(approved.json().approvedAt);
    const stored = getQuestion(context.db, question.id)!;
    assert.equal(stored.approvedBy, members.moderator.member.id);
  });

  it('puts approved questions in the public quiz and takes unpublished ones out', async () => {
    const created = await as('moderator', 'POST', '/api/member/questions', body(otherCategoryId, 'My own question?'));
    const { id } = created.json().question as MemberQuestion;
    const inQuiz = () => publicQuiz(context, otherCategoryId, 'all').questions.some((question) => question.id === id);
    assert.equal(inQuiz(), false);
    await as('moderator', 'POST', `/api/member/questions/${id}/submit`, { version: 1 });
    // Moderators may approve their own questions.
    assert.equal((await as('moderator', 'POST', `/api/member/questions/${id}/approve`, { version: 2 })).statusCode, 200);
    assert.equal(inQuiz(), true);
    // A Moderator's change keeps it approved.
    const changed = await as('moderator', 'PUT', `/api/member/questions/${id}`, body(otherCategoryId, 'My own question, changed?', { version: 3 }));
    assert.equal(changed.json().question.status, 'approved');
    assert.equal(inQuiz(), true);
    const unpublished = await as('moderator', 'POST', `/api/member/questions/${id}/unpublish`, { version: 4 });
    assert.equal(unpublished.json().status, 'draft');
    assert.equal(unpublished.json().approvedAt, null);
    assert.equal(inQuiz(), false);
  });

  it('answers 409 conflict to every change with an old version, changing nothing', async () => {
    const question = await seed('pending');
    await as('author', 'PUT', `/api/member/questions/${question.id}`, body(categoryId, 'Changed first?', { version: 1 }));
    const fresh = getQuestion(context.db, question.id)!;
    for (const action of ['edit', 'delete', 'approve', 'reject'] as const) {
      const response = await act(action === 'edit' || action === 'delete' ? 'author' : 'moderator', action, question.id, 1);
      assert.equal(response.statusCode, 409, action);
      assert.equal(response.json().error, 'conflict');
      assert.deepEqual(getQuestion(context.db, question.id), fresh);
    }
  });

  it('lists the author\'s own questions to Editors and every question to Moderators, newest first, a page at a time (API-8)', async () => {
    const list = context.db.connection.prepare('DELETE FROM questions');
    await withDataWrite(context.operations, () => list.run());
    const times = ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z'];
    const ids: string[] = [];
    for (const [index, at] of times.entries()) {
      const createdBy = index === 1 ? members.editor.member.id : members.author.member.id;
      const status = index === 2 ? 'pending' : 'draft';
      ids.push((await withDataWrite(context.operations, () => insertQuestion(context.db, sampleQuestion(categoryId, `Listed ${index}`, { status, createdBy, reviewNote: '' }), new Date(at)))).id);
    }
    const page = async (key: keyof typeof members, query = '') => (await as(key, 'GET', `/api/member/questions${query}`)).json() as { items: MemberQuestion[]; nextCursor: string | null };
    assert.deepEqual((await page('author')).items.map((question) => question.id), [ids[2], ids[0]]);
    // Editors never see others' questions, whatever they ask.
    assert.deepEqual((await page('editor', '?mine=false')).items.map((question) => question.id), [ids[1]]);
    assert.deepEqual((await page('moderator')).items.map((question) => question.id), [ids[2], ids[1], ids[0]]);
    assert.deepEqual((await page('moderator', '?mine=true')).items, []);
    assert.deepEqual((await page('moderator', '?status=pending')).items.map((question) => question.id), [ids[2]]);
    assert.deepEqual((await page('moderator', `?categoryId=${otherCategoryId}`)).items, []);
    assert.deepEqual((await page('moderator', '?q=listed%201')).items.map((question) => question.id), [ids[1]]);
    assert.equal((await page('moderator')).items[1].createdByName, 'Display q.editor');

    const first = await page('moderator', '?limit=2');
    assert.equal(first.items.length, 2);
    const second = await page('moderator', `?limit=2&cursor=${first.nextCursor}`);
    assert.deepEqual(second.items.map((question) => question.id), [ids[0]]);
    assert.equal(second.nextCursor, null);
    const bad = await as('moderator', 'GET', '/api/member/questions?cursor=nope');
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'invalid_request');

    assert.deepEqual((await as('author', 'GET', '/api/member/question-counts')).json(), { mine: { draft: 1, pending: 1, approved: 0, rejected: 0 }, reviewQueue: null });
    assert.deepEqual((await as('moderator', 'GET', '/api/member/question-counts')).json(), { mine: { draft: 0, pending: 0, approved: 0, rejected: 0 }, reviewQueue: 1 });
  });

  it('audits every change by question ID, status and changed field names, never the text (LOG-14)', async () => {
    const created = await as('author', 'POST', '/api/member/questions', body(categoryId, 'Secret prompt text?'));
    const { id } = created.json().question as MemberQuestion;
    await as('author', 'PUT', `/api/member/questions/${id}`, body(categoryId, 'Secret changed text?', { version: 1 }));
    await as('author', 'POST', `/api/member/questions/${id}/submit`, { version: 2 });
    await as('moderator', 'POST', `/api/member/questions/${id}/reject`, { version: 3, reviewNote: 'Secret review note' });
    await as('author', 'DELETE', `/api/member/questions/${id}?version=4`);
    const entries = context.logs.listAudit({}, null, 200).filter((entry) => entry.targetId === id);
    assert.deepEqual(entries.map((entry) => [entry.action, entry.actorType, entry.outcome]).reverse(), [
      ['createQuestion', 'member', 'success'],
      ['replaceQuestion', 'member', 'success'],
      ['submitQuestion', 'member', 'success'],
      ['rejectQuestion', 'member', 'success'],
      ['deleteQuestion', 'member', 'success'],
    ]);
    const replace = entries.find((entry) => entry.action === 'replaceQuestion')!;
    assert.deepEqual(replace.details, { changed: ['prompt'], status: 'draft' });
    assert.deepEqual(entries.find((entry) => entry.action === 'rejectQuestion')!.details, { from: 'pending', status: 'rejected' });
    assert.doesNotMatch(JSON.stringify(entries), /Secret/);
  });
});
