import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { AdminMember, QuestionReport } from '../../src/lib/api.js';
import { buildApp } from '../app.js';
import { withDataWrite } from '../dataWrite.js';
import { AdminMemberService } from '../members.js';
import { insertCategory } from '../repository/categories.js';
import { deleteQuestion, insertQuestion, type Question } from '../repository/questions.js';
import { createMember, memberCookie, sampleQuestion, testContext } from './helpers.js';

/** Question reports (#46): who may report and handle them, duplicates, versions, deletions and the audit log. */

const csrf = { 'x-agt-request': '1' };

describe('question reports', () => {
  const context = testContext();
  let app: FastifyInstance;
  let categoryId: string;
  const members: Record<'player' | 'editor' | 'moderator' | 'other', { member: AdminMember; cookie: string }> = {} as never;

  before(async () => {
    app = buildApp(context);
    await app.ready();
    ({ id: categoryId } = await withDataWrite(context.operations, () => insertCategory(context.db, { shortName: 'space', name: 'Space', description: 'd', priority: 0 })));
    for (const [key, role] of [['player', 'Player'], ['editor', 'Editor'], ['moderator', 'Moderator'], ['other', 'Player']] as const) {
      const member = await createMember(context, `r.${key}`, role);
      members[key] = { member, cookie: await memberCookie(context, `r.${key}`) };
    }
  });
  after(async () => { await app.close(); context.close(); });

  let count = 0;
  const seed = (status: Question['status'] = 'approved') => withDataWrite(context.operations, () => {
    count += 1;
    return insertQuestion(context.db, sampleQuestion(categoryId, `Reported question ${count}`, { status }));
  });
  const as = (key: keyof typeof members, method: 'GET' | 'POST', url: string, payload?: object, headers: Record<string, string> = csrf) => app.inject({
    method, url, headers: { cookie: members[key].cookie, ...(method === 'GET' ? {} : headers) }, ...(payload ? { payload } : {}),
  });
  const report = (key: keyof typeof members, questionId: string, reason = 'wrong_answer', note = '') => as(key, 'POST', `/api/member/questions/${questionId}/reports`, { reason, note });
  const close = (key: keyof typeof members, id: string, verb: 'resolve' | 'dismiss', version: number, resolutionNote = '') => (
    as(key, 'POST', `/api/member/reports/${id}/${verb}`, { version, resolutionNote })
  );
  const codes = (response: { json(): { fields: { field: string; code: string }[] } }) => response.json().fields.map((field) => [field.field, field.code]);

  it('lets every member report an approved question, with a reason and an optional note', async () => {
    const question = await seed();
    for (const key of ['player', 'editor', 'moderator'] as const) {
      const response = await report(key, question.id, 'typo', key === 'player' ? '  "Jupitre" is misspelt.  ' : '');
      assert.equal(response.statusCode, 201, response.body);
      const created = response.json() as QuestionReport;
      assert.equal(created.questionId, question.id);
      assert.equal(created.questionPrompt, question.prompt);
      assert.equal(created.categoryName, 'Space');
      assert.equal(created.status, 'open');
      assert.equal(created.reportedBy, members[key].member.id);
      assert.equal(created.reportedByName, members[key].member.displayName);
      if (key === 'player') assert.equal(created.note, '"Jupitre" is misspelt.');
    }
  });

  it('refuses visitors, the Admin cookie, a missing CSRF header, and questions that are not approved', async () => {
    const question = await seed();
    assert.equal((await app.inject({ method: 'POST', url: `/api/member/questions/${question.id}/reports`, headers: csrf, payload: { reason: 'typo', note: '' } })).statusCode, 401);
    assert.equal((await as('player', 'POST', `/api/member/questions/${question.id}/reports`, { reason: 'typo', note: '' }, {})).statusCode, 403);
    for (const status of ['draft', 'pending', 'rejected'] as const) {
      const hidden = await seed(status);
      const response = await report('player', hidden.id);
      assert.equal(response.statusCode, 404, status);
      assert.equal(response.json().error, 'not_found');
    }
    for (const id of ['not-a-uuid', '00000000-0000-4000-8000-000000000000']) assert.equal((await report('player', id)).statusCode, 404, id);
  });

  it('validates the reason and the note, and needs details for "other"', async () => {
    const question = await seed();
    assert.deepEqual(codes(await report('player', question.id, 'boring')), [['reason', 'not_allowed']]);
    assert.deepEqual(codes(await report('player', question.id, '')), [['reason', 'required']]);
    assert.deepEqual(codes(await report('player', question.id, 'other', '   ')), [['note', 'required']]);
    assert.deepEqual(codes(await report('player', question.id, 'unclear', 'x'.repeat(501))), [['note', 'too_long']]);
    assert.equal((await as('player', 'POST', `/api/member/questions/${question.id}/reports`, { reason: 'typo' })).statusCode, 400, 'note is required in the body');
    assert.equal((await report('player', question.id, 'other', 'The picture is gone.')).statusCode, 201);
  });

  it('keeps one open report per member and question, and allows a new one once it is closed', async () => {
    const question = await seed();
    const first = (await report('player', question.id)).json() as QuestionReport;
    const again = await report('player', question.id, 'unclear');
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error, 'report_exists');
    assert.equal((await report('other', question.id)).statusCode, 201, 'another member may report it too');
    assert.equal((await close('moderator', first.id, 'dismiss', first.version)).statusCode, 200);
    assert.equal((await report('player', question.id, 'unclear')).statusCode, 201);
  });

  it('lets only Moderators list, resolve and dismiss reports, oldest first, at a version', async () => {
    const question = await seed();
    const created = (await report('other', question.id, 'outdated', 'The base was renamed.')).json() as QuestionReport;
    for (const key of ['player', 'editor'] as const) {
      assert.equal((await as(key, 'GET', '/api/member/reports')).statusCode, 403, key);
      assert.equal((await close(key, created.id, 'resolve', created.version)).statusCode, 403, key);
    }
    const list = (await as('moderator', 'GET', '/api/member/reports')).json() as { items: QuestionReport[]; nextCursor: string | null };
    assert.ok(list.items.some((item) => item.id === created.id));
    const times = list.items.map((item) => item.createdAt);
    assert.deepEqual(times, [...times].sort(), 'oldest first');
    assert.ok(list.items.every((item) => item.status === 'open'));
    // Paging (API-8).
    const page = (await as('moderator', 'GET', '/api/member/reports?limit=1')).json();
    assert.equal(page.items.length, 1);
    assert.ok(page.nextCursor);
    const next = (await as('moderator', 'GET', `/api/member/reports?limit=1&cursor=${page.nextCursor}`)).json();
    assert.notEqual(next.items[0].id, page.items[0].id);
    assert.equal((await as('moderator', 'GET', '/api/member/reports?cursor=nope')).statusCode, 400);
    // The counts carry the open reports for Moderators only.
    const open = list.items.length;
    assert.equal((await as('moderator', 'GET', '/api/member/question-counts')).json().openReports, open);
    assert.equal((await as('editor', 'GET', '/api/member/question-counts')).json().openReports, null);

    assert.deepEqual(codes(await close('moderator', created.id, 'resolve', created.version, 'x'.repeat(501))), [['resolutionNote', 'too_long']]);
    assert.equal((await close('moderator', created.id, 'resolve', created.version + 1)).statusCode, 409, 'an old or wrong version');
    const resolved = await close('moderator', created.id, 'resolve', created.version, '  Renamed the base.  ');
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal(resolved.json().status, 'resolved');
    assert.equal(resolved.json().resolutionNote, 'Renamed the base.');
    assert.equal(resolved.json().resolvedByName, members.moderator.member.displayName);
    assert.equal(resolved.json().version, created.version + 1);
    assert.equal((await close('moderator', created.id, 'dismiss', resolved.json().version)).statusCode, 409, 'no longer open');
    const closed = (await as('moderator', 'GET', '/api/member/reports?status=resolved')).json().items as QuestionReport[];
    assert.ok(closed.some((item) => item.id === created.id));
    assert.equal((await as('moderator', 'GET', '/api/member/question-counts')).json().openReports, open - 1);
    assert.equal((await close('moderator', '00000000-0000-4000-8000-000000000000', 'resolve', 1)).statusCode, 404);
  });

  it('goes with its question, and keeps a deleted member\'s report without their name', async () => {
    const question = await seed();
    const gone = await createMember(context, 'r.gone', 'Player');
    const created = (await as('player', 'POST', `/api/member/questions/${question.id}/reports`, { reason: 'typo', note: '' })).json() as QuestionReport;
    const byGone = await app.inject({
      method: 'POST', url: `/api/member/questions/${question.id}/reports`, headers: { cookie: await memberCookie(context, 'r.gone'), ...csrf }, payload: { reason: 'unclear', note: '' },
    });
    assert.equal(byGone.statusCode, 201);
    await withDataWrite(context.operations, () => new AdminMemberService(context).delete(gone.id));
    const list = (await as('moderator', 'GET', '/api/member/reports?limit=200')).json().items as QuestionReport[];
    const orphan = list.find((item) => item.id === byGone.json().id)!;
    assert.equal(orphan.reportedBy, null);
    assert.equal(orphan.reportedByName, null);
    await withDataWrite(context.operations, () => deleteQuestion(context.db, question.id, question.version));
    const after = (await as('moderator', 'GET', '/api/member/reports?limit=200')).json().items as QuestionReport[];
    assert.ok(!after.some((item) => item.id === created.id || item.id === orphan.id), 'deleted with the question');
  });

  it('audits reports by question and reason, never the notes (LOG-14)', async () => {
    const question = await seed();
    const created = (await report('other', question.id, 'other', 'Secret detail 12345')).json() as QuestionReport;
    await close('moderator', created.id, 'dismiss', created.version, 'Private reply 67890');
    const entries = context.logs.listAudit({}, null, 500).filter((entry) => entry.targetId === created.id);
    assert.deepEqual(entries.map((entry) => entry.action).sort(), ['dismissReport', 'reportQuestion']);
    const made = entries.find((entry) => entry.action === 'reportQuestion')!;
    assert.deepEqual(made.details, { questionId: question.id, reason: 'other', note: true });
    assert.equal(made.actorType, 'member');
    assert.doesNotMatch(JSON.stringify(entries), /Secret detail|Private reply/);
  });
});
