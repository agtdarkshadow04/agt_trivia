import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { AdminMember } from '../../src/lib/api.js';
import { buildApp } from '../app.js';
import { withDataWrite } from '../dataWrite.js';
import { insertResult } from '../repository/results.js';
import { adminCookie, createMember, memberCookie, seedQuiz, testContext } from './helpers.js';

/** Opt-in leaderboards (#49): closed by default, opt-in only, display names only, and only signed results of at least minimumAnswers answers (#60). */

const csrf = { 'x-agt-request': '1' };

describe('leaderboards while turned off', () => {
  const context = testContext();
  let app: FastifyInstance;
  before(async () => { app = buildApp(context); await app.ready(); });
  after(async () => { await app.close(); context.close(); });

  it('answers 403 leaderboards_closed, and the public settings say so', async () => {
    const { category } = await seedQuiz(context);
    const response = await app.inject(`/api/categories/${category.id}/leaderboard`);
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'leaderboards_closed');
    assert.equal((await app.inject('/api/settings/public')).json().leaderboards, false);
  });
});

describe('leaderboards', () => {
  const context = testContext('leaderboards:\n  enabled: true\n  size: 4\n');
  let app: FastifyInstance;
  let space: Awaited<ReturnType<typeof seedQuiz>>;
  let other: Awaited<ReturnType<typeof seedQuiz>>;
  const members: Record<string, AdminMember> = {};
  const cookies: Record<string, string> = {};

  before(async () => {
    app = buildApp(context);
    await app.ready();
    space = await seedQuiz(context, 12);
    other = await seedQuiz(context, 12, { shortName: 'other', name: 'Other' });
    for (const name of ['ada', 'bob', 'cleo', 'dan', 'eve', 'finn', 'hidden', 'gone']) {
      members[name] = await createMember(context, `lb.${name}`);
      cookies[name] = await memberCookie(context, `lb.${name}`);
    }
  });
  after(async () => { await app.close(); context.close(); });

  const preferences = (name: string, optIn?: boolean) => app.inject(optIn === undefined
    ? { url: '/api/member/preferences', headers: { cookie: cookies[name] } }
    : { method: 'PUT', url: '/api/member/preferences', headers: { cookie: cookies[name], ...csrf }, payload: { leaderboardOptIn: optIn } });
  /** A saved result of `right` out of `total` answers, at minute `minute`; signed unless `attempt` is false. */
  const result = (name: string, right: number, total: number, options: { minute?: number; length?: 'short' | 'long' | 'all'; attempt?: boolean; categoryId?: string } = {}) => (
    withDataWrite(context.operations, () => insertResult(context.db, {
      memberId: members[name].id,
      categoryId: options.categoryId ?? space.category.id,
      categoryName: 'Space',
      length: options.length ?? 'all',
      attemptId: options.attempt === false ? null : randomUUID(),
      answers: Array.from({ length: total }, (_, index) => ({ questionId: space.questions[0].id, correct: index < right })),
    }, new Date(Date.UTC(2030, 0, 1, 0, options.minute ?? 0))))
  );
  const board = async () => {
    const response = await app.inject(`/api/categories/${space.category.id}/leaderboard`);
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as { minimumAnswers: number; entries: { rank: number; displayName: string; bestPercent: number; plays: number }[] };
  };

  it('keeps each member\'s choice, off by default, for themselves only', async () => {
    assert.deepEqual((await preferences('ada')).json(), { leaderboardOptIn: false });
    assert.equal((await app.inject('/api/member/preferences')).statusCode, 401);
    const admin = await adminCookie(context);
    assert.equal((await app.inject({ url: '/api/member/preferences', headers: { cookie: admin } })).statusCode, 401, 'the Admin is not a member');
    const noCsrf = await app.inject({ method: 'PUT', url: '/api/member/preferences', headers: { cookie: cookies.ada }, payload: { leaderboardOptIn: true } });
    assert.equal(noCsrf.json().error, 'csrf');
    assert.equal((await preferences('ada', 'yes' as unknown as boolean)).statusCode, 400);
    const turnedOn = await preferences('ada', true);
    assert.equal(turnedOn.statusCode, 200);
    assert.deepEqual(turnedOn.json(), { leaderboardOptIn: true });
    assert.deepEqual((await preferences('bob')).json(), { leaderboardOptIn: false }, 'nobody else changed');
    const entry = context.logs.listAudit({}, null, 100).find((candidate) => candidate.action === 'replaceMemberPreferences')!;
    assert.deepEqual(entry.details, { leaderboardOptIn: true });
  });

  it('ranks opted-in members by best percentage, then plays, then who got there first, display names only', async () => {
    for (const name of ['ada', 'bob', 'cleo', 'dan', 'eve', 'finn', 'gone']) await preferences(name, true);
    await result('ada', 9, 10, { minute: 1 });          // 90 %
    await result('ada', 6, 10, { minute: 2 });          // two plays
    await result('bob', 9, 10, { minute: 3 });          // 90 %, one play: below Ada
    await result('cleo', 12, 12, { minute: 4 });        // 100 %
    await result('dan', 9, 10, { minute: 0 });          // 90 %, first to get there, one play: above Bob
    await result('eve', 5, 10, { minute: 5 });          // 50 %: fifth, beyond leaderboards.size 4
    await result('finn', 1, 10, { minute: 6 });
    // None of these count.
    await result('hidden', 10, 10);                      // never opted in
    await result('finn', 10, 10, { attempt: false });    // no signed attempt (#45)
    await result('finn', 9, 9);                          // fewer answers than quiz.shortLength
    await result('finn', 9, 9, { length: 'short' });     // a short quiz with fewer, too
    await result('finn', 10, 10, { categoryId: other.category.id });
    await result('gone', 10, 10);
    await withDataWrite(context.operations, () => context.db.connection.prepare('UPDATE members SET is_active = 0 WHERE id = ?').run(members.gone.id));

    const { minimumAnswers, entries } = await board();
    assert.equal(minimumAnswers, 10);
    assert.deepEqual(entries, [
      { rank: 1, displayName: 'Display lb.cleo', bestPercent: 100, plays: 1 },
      { rank: 2, displayName: 'Display lb.ada', bestPercent: 90, plays: 2 },
      { rank: 3, displayName: 'Display lb.dan', bestPercent: 90, plays: 1 },
      { rank: 4, displayName: 'Display lb.bob', bestPercent: 90, plays: 1 },
    ]);
    const body = (await app.inject(`/api/categories/${space.category.id}/leaderboard`)).body;
    // No member ID, username or other field: display names here contain the username, so look for it as a value.
    for (const secret of Object.values(members).map((member) => member.id).concat(['"lb\\.cleo"', 'username', 'memberId', 'travellerId'])) {
      assert.doesNotMatch(body, new RegExp(secret), secret);
    }
  });

  it('drops a member who opts out at once, and lets a small category count its full quiz', async () => {
    await preferences('cleo', false);
    assert.ok(!(await board()).entries.some((entry) => entry.displayName === 'Display lb.cleo'));
    const small = await seedQuiz(context, 3, { shortName: 'small', name: 'Small' });
    await withDataWrite(context.operations, () => insertResult(context.db, {
      memberId: members.ada.id, categoryId: small.category.id, categoryName: 'Small', length: 'all', attemptId: randomUUID(),
      answers: small.questions.map((question) => ({ questionId: question.id, correct: true })),
    }));
    const smallBoard = (await app.inject(`/api/categories/${small.category.id}/leaderboard`)).json();
    assert.equal(smallBoard.minimumAnswers, 3);
    assert.deepEqual(smallBoard.entries, [{ rank: 1, displayName: 'Display lb.ada', bestPercent: 100, plays: 1 }]);
  });

  it('answers 404 for an unknown or malformed category, and writes nothing', async () => {
    for (const id of [randomUUID(), 'nope']) {
      const response = await app.inject(`/api/categories/${id}/leaderboard`);
      assert.equal(response.statusCode, 404, id);
    }
    assert.equal((await app.inject('/api/settings/public')).json().leaderboards, true);
  });

  it('counts a short quiz with enough answers, as the board says (#60)', async () => {
    const shorty = await createMember(context, 'lb.shorty');
    cookies.shorty = await memberCookie(context, 'lb.shorty');
    members.shorty = shorty;
    await preferences('shorty', true);
    // A short quiz of quiz.shortLength (10) answers, all right: the length players most often choose.
    await result('shorty', 10, 10, { length: 'short', minute: 30 });
    const { minimumAnswers, entries } = await board();
    assert.equal(minimumAnswers, 10);
    assert.deepEqual(entries.find((entry) => entry.displayName === 'Display lb.shorty'), { rank: entries.findIndex((entry) => entry.displayName === 'Display lb.shorty') + 1, displayName: 'Display lb.shorty', bestPercent: 100, plays: 1 });
  });
});
