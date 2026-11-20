import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { ManagedCategory } from '../../src/lib/api.js';
import { buildApp } from '../app.js';
import { withDataWrite } from '../dataWrite.js';
import { getCategory, insertCategory } from '../repository/categories.js';
import { getQuestion, insertQuestion } from '../repository/questions.js';
import { insertResult } from '../repository/results.js';
import { createMember, memberCookie, sampleQuestion, testContext } from './helpers.js';

/** Category management (#20): Moderators only, validation, optimistic concurrency, the refused delete, the audit log. */

const csrf = { 'x-agt-request': '1' };
const body = (shortName: string, name: string, extra: Record<string, unknown> = {}) => ({ shortName, name, description: `About ${name}.`, priority: 10, ...extra });

describe('category management', () => {
  const context = testContext();
  let app: FastifyInstance;
  const cookies: Record<'player' | 'editor' | 'moderator', string> = {} as never;

  before(async () => {
    app = buildApp(context);
    await app.ready();
    for (const [key, role] of [['player', 'Player'], ['editor', 'Editor'], ['moderator', 'Moderator']] as const) {
      await createMember(context, `c.${key}`, role);
      cookies[key] = await memberCookie(context, `c.${key}`);
    }
  });
  after(async () => { await app.close(); context.close(); });

  const as = (key: keyof typeof cookies, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({
    method, url, headers: { cookie: cookies[key], ...(method === 'GET' ? {} : csrf) }, ...(payload ? { payload } : {}),
  });
  const seed = (shortName: string, name: string, priority = 10) => withDataWrite(context.operations, () => insertCategory(context.db, { shortName, name, description: 'd', priority }));

  it('lets only Moderators manage categories, and never a visitor or a request without the CSRF header', async () => {
    const category = await seed('authz', 'Authorization');
    for (const key of ['player', 'editor'] as const) {
      const responses = [
        await as(key, 'GET', '/api/member/categories'),
        await as(key, 'POST', '/api/member/categories', body('x', 'X')),
        await as(key, 'PUT', `/api/member/categories/${category.id}`, body('x', 'X', { version: 1 })),
        await as(key, 'DELETE', `/api/member/categories/${category.id}?version=1`),
      ];
      for (const response of responses) {
        assert.equal(response.statusCode, 403, `${key} ${response.body}`);
        assert.equal(response.json().error, 'forbidden');
      }
    }
    assert.equal((await app.inject({ url: '/api/member/categories' })).statusCode, 401);
    const noCsrf = await app.inject({ method: 'POST', url: '/api/member/categories', headers: { cookie: cookies.moderator }, payload: body('x', 'X') });
    assert.equal(noCsrf.json().error, 'csrf');
    assert.deepEqual(getCategory(context.db, category.id), category);
  });

  it('creates, lists in display order with counts per status, and replaces categories', async () => {
    const created = await as('moderator', 'POST', '/api/member/categories', body('  Deep-Space ', ' Deep space ', { priority: 0 }));
    assert.equal(created.statusCode, 201);
    const { category, notices } = created.json() as { category: ManagedCategory; notices: unknown[] };
    assert.deepEqual(notices, []);
    assert.equal(category.shortName, 'Deep-Space');
    assert.equal(category.name, 'Deep space');
    assert.equal(category.version, 1);
    assert.deepEqual(category.questionCounts, { draft: 0, pending: 0, approved: 0, rejected: 0 });

    await withDataWrite(context.operations, () => {
      for (const status of ['approved', 'approved', 'pending', 'draft'] as const) {
        insertQuestion(context.db, sampleQuestion(category.id, `Counted ${status} ${Math.random()}`, { status }));
      }
    });
    const list = (await as('moderator', 'GET', '/api/member/categories')).json() as ManagedCategory[];
    assert.equal(list[0].id, category.id);
    assert.deepEqual(list[0].questionCounts, { draft: 1, pending: 1, approved: 2, rejected: 0 });
    // The public list counts approved questions only.
    assert.equal((await app.inject('/api/categories')).json().find((entry: { id: string }) => entry.id === category.id).questionCount, 2);

    const replaced = await as('moderator', 'PUT', `/api/member/categories/${category.id}`, body('deep', 'Deep space', { version: 1, priority: 50 }));
    assert.equal(replaced.statusCode, 200);
    assert.equal(replaced.json().category.shortName, 'deep');
    assert.equal(replaced.json().category.version, 2);
    assert.equal(replaced.json().category.questionCounts.approved, 2);
    // The old link no longer finds it; the new one does.
    assert.equal((await app.inject('/api/categories')).json().find((entry: { id: string }) => entry.id === category.id).shortName, 'deep');
  });

  it('checks categories with the shared validators and refuses names in use, ignoring case', async () => {
    await seed('taken', 'Taken name');
    const invalid = await as('moderator', 'POST', '/api/member/categories', { shortName: 'with space', name: ' ', description: '', priority: 101 });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.json().fields.map((field: { field: string; code: string }) => [field.field, field.code]), [
      ['shortName', 'invalid_format'], ['name', 'required'], ['description', 'required'], ['priority', 'out_of_range'],
    ]);
    const duplicate = await as('moderator', 'POST', '/api/member/categories', body('TAKEN', 'taken NAME'));
    assert.deepEqual(duplicate.json().fields.map((field: { field: string; code: string }) => [field.field, field.code]), [['shortName', 'duplicate'], ['name', 'duplicate']]);
    // A category keeps its own names, in another case too.
    const own = await seed('own', 'Own name');
    const kept = await as('moderator', 'PUT', `/api/member/categories/${own.id}`, body('OWN', 'own NAME', { version: 1 }));
    assert.equal(kept.statusCode, 200);
    const stolen = await as('moderator', 'PUT', `/api/member/categories/${own.id}`, body('taken', 'Own name', { version: 2 }));
    assert.deepEqual(stolen.json().fields.map((field: { field: string; code: string }) => [field.field, field.code]), [['shortName', 'duplicate']]);
    const undeclared = await as('moderator', 'POST', '/api/member/categories', { ...body('extra', 'Extra'), questionCount: 3 });
    assert.equal(undeclared.statusCode, 400);
    assert.equal((await as('moderator', 'PUT', '/api/member/categories/not-an-id', body('x', 'X', { version: 1 }))).statusCode, 404);
  });

  it('answers 409 conflict to a replace or delete with an old version, changing nothing', async () => {
    const category = await seed('versioned', 'Versioned');
    await as('moderator', 'PUT', `/api/member/categories/${category.id}`, body('versioned', 'Versioned', { version: 1, priority: 3 }));
    const stored = getCategory(context.db, category.id);
    const stale = await as('moderator', 'PUT', `/api/member/categories/${category.id}`, body('other', 'Other', { version: 1 }));
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error, 'conflict');
    const staleDelete = await as('moderator', 'DELETE', `/api/member/categories/${category.id}?version=1`);
    assert.equal(staleDelete.statusCode, 409);
    assert.equal(staleDelete.json().error, 'conflict');
    assert.deepEqual(getCategory(context.db, category.id), stored);
  });

  it('refuses to delete a category with questions of any status, and deletes an empty one', async () => {
    const category = await seed('busy', 'Busy');
    const question = await withDataWrite(context.operations, () => insertQuestion(context.db, sampleQuestion(category.id, 'Only a draft', { status: 'draft' })));
    const refused = await as('moderator', 'DELETE', `/api/member/categories/${category.id}?version=1`);
    assert.equal(refused.statusCode, 409);
    assert.deepEqual(refused.json(), { error: 'category_not_empty', message: 'The category still has questions. Move or delete them first.', params: { count: 1 } });
    assert.ok(getCategory(context.db, category.id));

    // Moving the question to another category empties it.
    const other = await seed('elsewhere', 'Elsewhere');
    const moderator = await memberCookie(context, 'c.moderator');
    const moved = await app.inject({
      method: 'PUT', url: `/api/member/questions/${question.id}`, headers: { cookie: moderator, ...csrf },
      payload: { categoryId: other.id, prompt: question.prompt, choices: question.choices.map(({ text, isCorrect }) => ({ text, isCorrect })), version: 1 },
    });
    assert.equal(moved.statusCode, 200);
    const deleted = await as('moderator', 'DELETE', `/api/member/categories/${category.id}?version=1`);
    assert.equal(deleted.statusCode, 204);
    assert.equal(getCategory(context.db, category.id), null);
  });

  it('audits every change by category ID, short name and changed field names (LOG-14)', async () => {
    const created = await as('moderator', 'POST', '/api/member/categories', body('audited', 'Audited'));
    const { id } = created.json().category as ManagedCategory;
    await as('moderator', 'PUT', `/api/member/categories/${id}`, body('audited', 'Audited', { version: 1, description: 'Secret description.' }));
    await as('moderator', 'DELETE', `/api/member/categories/${id}?version=2`);
    const entries = context.logs.listAudit({}, null, 200).filter((entry) => entry.targetId === id).reverse();
    assert.deepEqual(entries.map((entry) => [entry.action, entry.actorType, entry.outcome]), [
      ['createCategory', 'member', 'success'], ['replaceCategory', 'member', 'success'], ['deleteCategory', 'member', 'success'],
    ]);
    assert.deepEqual(entries[1].details, { shortName: 'audited', changed: ['description'] });
    assert.doesNotMatch(JSON.stringify(entries), /Secret/);
  });

  describe('moving every question of a category (#47)', () => {
    const question = (categoryId: string, prompt: string, status: 'draft' | 'pending' | 'approved' | 'rejected' = 'approved') => (
      withDataWrite(context.operations, () => insertQuestion(context.db, sampleQuestion(categoryId, prompt, { status })))
    );
    const move = (key: keyof typeof cookies, id: string, payload: object) => as(key, 'POST', `/api/member/categories/${id}/move-questions`, payload);
    const codes = (response: { json(): { fields: { field: string; code: string }[] } }) => response.json().fields.map((field) => [field.field, field.code]);

    it('moves questions of every status, with new versions, so the source can be deleted', async () => {
      const source = await seed('old-moons', 'Old moons');
      const target = await seed('moons', 'Moons');
      const moved = await Promise.all([
        question(source.id, 'Which moon is largest?'),
        question(source.id, 'Draft moon?', 'draft'),
        question(source.id, 'Pending moon?', 'pending'),
        question(source.id, 'Rejected moon?', 'rejected'),
      ]);
      await question(target.id, 'which moon is LARGEST?');
      // A member's saved result keeps its category.
      const member = (await as('player', 'GET', '/api/member/session')).json() as { id: string };
      await withDataWrite(context.operations, () => insertResult(context.db, {
        memberId: member.id, categoryId: source.id, categoryName: source.name, length: 'all', answers: [{ questionId: moved[0].id, correct: true }],
      }));

      const response = await move('moderator', source.id, { targetCategoryId: target.id.toUpperCase(), version: source.version });
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json();
      assert.equal(result.moved, 4);
      assert.deepEqual(result.source.questionCounts, { draft: 0, pending: 0, approved: 0, rejected: 0 });
      assert.deepEqual(result.target.questionCounts, { draft: 1, pending: 1, approved: 2, rejected: 1 });
      assert.equal(result.source.version, source.version, 'the category itself did not change');
      // The duplicate prompt is a notice, not an error (API-2).
      assert.deepEqual(result.notices.map((notice: { field: string; code: string; params: unknown }) => [notice.field, notice.code, notice.params]), [['targetCategoryId', 'duplicate', { count: 1 }]]);
      const moderator = (await as('moderator', 'GET', '/api/member/session')).json() as { id: string };
      for (const before of moved) {
        const after = getQuestion(context.db, before.id)!;
        assert.equal(after.categoryId, target.id);
        assert.equal(after.status, before.status);
        assert.equal(after.version, before.version + 1);
        assert.equal(after.modifiedBy, moderator.id);
      }
      const results = (await as('player', 'GET', `/api/member/results?categoryId=${source.id}`)).json().items as { categoryId: string }[];
      assert.equal(results.length, 1, 'the result still belongs to the old category');
      // The public quiz of the target now has both approved questions.
      assert.equal((await app.inject(`/api/categories/${target.id}/quiz?length=all`)).json().questions.length, 2);
      assert.equal((await as('moderator', 'DELETE', `/api/member/categories/${source.id}?version=${source.version}`)).statusCode, 204);
    });

    it('checks the target and the version, and moving an empty category moves nothing', async () => {
      const source = await seed('move-src', 'Move source');
      const target = await seed('move-dst', 'Move target');
      await question(source.id, 'Stays put?');
      assert.deepEqual(codes(await move('moderator', source.id, { targetCategoryId: '', version: source.version })), [['targetCategoryId', 'required']]);
      assert.deepEqual(codes(await move('moderator', source.id, { targetCategoryId: source.id, version: source.version })), [['targetCategoryId', 'not_allowed']]);
      for (const unknown of ['nope', '00000000-0000-4000-8000-000000000000']) {
        assert.deepEqual(codes(await move('moderator', source.id, { targetCategoryId: unknown, version: source.version })), [['targetCategoryId', 'not_allowed']], unknown);
      }
      assert.equal((await move('moderator', source.id, { targetCategoryId: target.id, version: source.version + 1 })).statusCode, 409);
      assert.equal((await move('moderator', '00000000-0000-4000-8000-000000000000', { targetCategoryId: target.id, version: 1 })).statusCode, 404);
      assert.equal((await move('moderator', source.id, { targetCategoryId: target.id })).statusCode, 400, 'version is required');
      assert.equal(getCategory(context.db, source.id)!.version, source.version);
      const empty = await seed('move-empty', 'Move empty');
      const none = await move('moderator', empty.id, { targetCategoryId: target.id, version: empty.version });
      assert.equal(none.statusCode, 200);
      assert.equal(none.json().moved, 0);
      assert.deepEqual(none.json().notices, []);
    });

    it('is for Moderators only, with the CSRF header, and is audited with the counts', async () => {
      const source = await seed('audit-src', 'Audit source');
      const target = await seed('audit-dst', 'Audit target');
      await question(source.id, 'Audited move?');
      for (const key of ['player', 'editor'] as const) {
        assert.equal((await move(key, source.id, { targetCategoryId: target.id, version: source.version })).statusCode, 403, key);
      }
      const noCsrf = await app.inject({
        method: 'POST', url: `/api/member/categories/${source.id}/move-questions`, headers: { cookie: cookies.moderator }, payload: { targetCategoryId: target.id, version: source.version },
      });
      assert.equal(noCsrf.json().error, 'csrf');
      assert.equal((await move('moderator', source.id, { targetCategoryId: target.id, version: source.version })).statusCode, 200);
      const entry = context.logs.listAudit({}, null, 200).find((candidate) => candidate.action === 'moveCategoryQuestions' && candidate.targetId === source.id && candidate.outcome === 'success')!;
      assert.deepEqual(entry.details, { shortName: 'audit-src', to: target.id, toShortName: 'audit-dst', moved: 1 });
    });
  });
});
