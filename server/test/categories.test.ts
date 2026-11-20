import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { ManagedCategory } from '../../src/lib/api.js';
import { buildApp } from '../app.js';
import { withDataWrite } from '../dataWrite.js';
import { getCategory, insertCategory } from '../repository/categories.js';
import { insertQuestion } from '../repository/questions.js';
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
});
