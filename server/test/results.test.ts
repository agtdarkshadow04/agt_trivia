import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { withDataWrite } from '../dataWrite.js';
import { AdminMemberService } from '../members.js';
import { deleteCategory, insertCategory } from '../repository/categories.js';
import { insertQuestion, type Question } from '../repository/questions.js';
import { insertResult } from '../repository/results.js';
import { adminCookie, createMember, memberCookie, sampleQuestion, seedQuiz, testContext } from './helpers.js';

/** Member score history (#21): grading on the server, only one's own results, stats, clearing, and the audit log. */

const csrf = { 'x-agt-request': '1' };

/** The answer that chooses exactly the correct choices of `question` (or the first wrong one). */
const answer = (question: Question, right = true) => ({
  questionId: question.id,
  choiceIds: right ? question.choices.filter((choice) => choice.isCorrect).map((choice) => choice.id) : [question.choices.find((choice) => !choice.isCorrect)!.id],
});

describe('member score history', () => {
  const context = testContext();
  let app: FastifyInstance;
  let space: Awaited<ReturnType<typeof seedQuiz>>;
  let multi: Question;
  let otherCategory: Question;
  const cookies: Record<'ada' | 'bob', string> = {} as never;

  before(async () => {
    app = buildApp(context);
    await app.ready();
    space = await seedQuiz(context, 3);
    multi = await withDataWrite(context.operations, () => insertQuestion(context.db, sampleQuestion(space.category.id, 'Pick both', {
      choices: [{ text: 'Right one', isCorrect: true }, { text: 'Right two', isCorrect: true }, { text: 'Wrong', isCorrect: false }],
    })));
    const biology = await withDataWrite(context.operations, () => insertCategory(context.db, { shortName: 'bio', name: 'Biology', description: 'd', priority: 20 }));
    otherCategory = await withDataWrite(context.operations, () => insertQuestion(context.db, sampleQuestion(biology.id, 'Cells?')));
    for (const [key, role] of [['ada', 'Player'], ['bob', 'Moderator']] as const) {
      await createMember(context, `r.${key}`, role);
      cookies[key] = await memberCookie(context, `r.${key}`);
    }
  });
  after(async () => { await app.close(); context.close(); });

  const as = (key: keyof typeof cookies, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) => app.inject({
    method, url, headers: { cookie: cookies[key], ...(method === 'GET' ? {} : csrf) }, ...(payload ? { payload } : {}),
  });
  const submit = (key: keyof typeof cookies, answers: object[], extra: Record<string, unknown> = {}) => as(key, 'POST', '/api/member/results', {
    categoryId: space.category.id, length: 'short', answers, ...extra,
  });
  const codes = (response: { json(): { fields: { field: string; code: string }[] } }) => response.json().fields.map((field) => [field.field, field.code]);

  it('grades single- and multi-answer questions on the server', async () => {
    const [first, second, third] = space.questions;
    const partial = { questionId: multi.id, choiceIds: [multi.choices[0].id] };
    const response = await submit('ada', [answer(first), answer(second, false), answer(multi), { questionId: third.id, choiceIds: [] }]);
    assert.equal(response.statusCode, 201, response.body);
    const { result, skippedQuestionIds, notices } = response.json();
    assert.deepEqual(skippedQuestionIds, []);
    assert.deepEqual(notices, []);
    assert.equal(result.score, 2);
    assert.equal(result.total, 4);
    assert.equal(result.percent, 50);
    assert.equal(result.categoryName, 'Space');
    assert.equal(result.length, 'short');
    // Half of a multi-answer question is wrong.
    assert.equal((await submit('ada', [partial])).json().result.score, 0);
    // The browser's own score is never accepted.
    const claimed = await submit('ada', [answer(first)], { score: 10 });
    assert.equal(claimed.statusCode, 400);
    assert.deepEqual(codes(claimed), [['score', 'not_allowed']]);
  });

  it('refuses answers to another category, repeated questions or choices, foreign choices and too many answers', async () => {
    const [first] = space.questions;
    const wrong = await submit('ada', [answer(first), answer(otherCategory)]);
    assert.equal(wrong.statusCode, 400);
    assert.deepEqual(codes(wrong), [['answers.1', 'not_allowed']]);
    assert.deepEqual(codes(await submit('ada', [answer(first), answer(first, false)])), [['answers.1', 'duplicate']]);
    assert.deepEqual(codes(await submit('ada', [{ questionId: multi.id, choiceIds: [multi.choices[0].id, multi.choices[0].id] }])), [['answers.0', 'duplicate']]);
    assert.deepEqual(codes(await submit('ada', [{ questionId: first.id, choiceIds: [otherCategory.choices[0].id] }])), [['answers.0', 'not_allowed']]);
    assert.deepEqual(codes(await submit('ada', [{ questionId: 'nope', choiceIds: [] }])), [['answers.0', 'invalid_format']]);
    assert.deepEqual(codes(await submit('ada', [])), [['answers', 'too_few']]);
    // Space has 4 approved questions: 5 answers are too many, whatever they are.
    const five = [...space.questions, multi, space.hidden[0]].map((question) => answer(question));
    assert.deepEqual(codes(await submit('ada', five))[0], ['answers', 'too_many']);
    const unknown = await submit('ada', [answer(first)], { categoryId: '00000000-0000-4000-8000-000000000000' });
    assert.equal(unknown.statusCode, 404);
    assert.equal((await submit('ada', [answer(first)], { length: 'endless' })).statusCode, 400);
  });

  it('leaves out and reports questions that are no longer approved', async () => {
    const [first] = space.questions;
    const pending = space.hidden.find((question) => question.status === 'pending')!;
    const gone = await withDataWrite(context.operations, () => insertQuestion(context.db, sampleQuestion(space.category.id, 'Soon gone')));
    await withDataWrite(context.operations, () => context.db.connection.prepare('DELETE FROM questions WHERE id = ?').run(gone.id));
    const response = await submit('ada', [answer(first), answer(pending), answer(gone)]);
    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.json().skippedQuestionIds.sort(), [pending.id, gone.id].sort());
    assert.equal(response.json().result.total, 1);
    const nothing = await submit('ada', [answer(pending)]);
    assert.equal(nothing.statusCode, 409);
    assert.equal(nothing.json().error, 'conflict');
  });

  it('shows each member only their own results, newest first, a page at a time (API-8), and their stats', async () => {
    const own = await as('bob', 'GET', '/api/member/results');
    assert.deepEqual(own.json(), { items: [], nextCursor: null });
    assert.deepEqual((await as('bob', 'GET', '/api/member/stats')).json(), []);
    const [first, second] = space.questions;
    // Two results a minute apart, the later one at 50 %.
    const bob = context.db.connection.prepare("SELECT id FROM members WHERE username = 'r.bob'").get() as { id: string };
    for (const [minute, right] of [[1, true], [2, false]] as const) {
      await withDataWrite(context.operations, () => insertResult(context.db, {
        memberId: bob.id, categoryId: space.category.id, categoryName: 'Space', length: 'short',
        answers: [{ questionId: first.id, correct: right }, { questionId: second.id, correct: true }],
      }, new Date(Date.UTC(2030, 0, 1, 0, minute))));
    }
    const page = (await as('bob', 'GET', '/api/member/results?limit=1')).json();
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].percent, 50);
    const next = (await as('bob', 'GET', `/api/member/results?limit=1&cursor=${page.nextCursor}`)).json();
    assert.equal(next.items[0].percent, 100);
    assert.equal(next.nextCursor, null);
    assert.equal((await as('bob', 'GET', '/api/member/results?cursor=nope')).statusCode, 400);
    assert.deepEqual((await as('bob', 'GET', `/api/member/results?categoryId=${otherCategory.categoryId}`)).json().items, []);
    const [stats] = (await as('bob', 'GET', '/api/member/stats')).json();
    assert.deepEqual({ ...stats, lastPlayedAt: undefined }, { categoryId: space.category.id, categoryName: 'Space', plays: 2, bestPercent: 100, averagePercent: 75, lastPlayedAt: undefined });
    // Ada's results are hers alone.
    assert.ok((await as('ada', 'GET', '/api/member/results')).json().items.every((item: { id: string }) => !page.items.some((other: { id: string }) => other.id === item.id)));
  });

  it('shows 100 % only for a perfect score, in results and stats (#42)', async () => {
    const bob = context.db.connection.prepare("SELECT id FROM members WHERE username = 'r.bob'").get() as { id: string };
    const biology = otherCategory.categoryId;
    // 199 of 200 (99.5 %), then 200 of 200: the average is 99.75 %.
    for (const [minute, wrong] of [[10, 1], [11, 0]] as const) {
      await withDataWrite(context.operations, () => insertResult(context.db, {
        memberId: bob.id, categoryId: biology, categoryName: 'Biology', length: 'all',
        answers: Array.from({ length: 200 }, (_, index) => ({ questionId: otherCategory.id, correct: index >= wrong })),
      }, new Date(Date.UTC(2030, 0, 1, 0, minute))));
    }
    const items = (await as('bob', 'GET', `/api/member/results?categoryId=${biology}`)).json().items;
    assert.deepEqual(items.map((item: { score: number; percent: number }) => [item.score, item.percent]), [[200, 100], [199, 99]]);
    const stats = (await as('bob', 'GET', '/api/member/stats')).json().find((entry: { categoryId: string }) => entry.categoryId === biology);
    assert.equal(stats.bestPercent, 100);
    assert.equal(stats.averagePercent, 99);
  });

  it('keeps results of a deleted category with its name, out of the stats', async () => {
    await createMember(context, 'r.cleo', 'Player');
    const cleo = await memberCookie(context, 'r.cleo');
    const empty = await withDataWrite(context.operations, () => insertCategory(context.db, { shortName: 'brief', name: 'Brief', description: 'd', priority: 1 }));
    const question = await withDataWrite(context.operations, () => insertQuestion(context.db, sampleQuestion(empty.id, 'Brief?')));
    await app.inject({ method: 'POST', url: '/api/member/results', headers: { cookie: cleo, ...csrf }, payload: { categoryId: empty.id, length: 'all', answers: [answer(question)] } });
    await withDataWrite(context.operations, () => {
      context.db.connection.prepare('DELETE FROM questions WHERE id = ?').run(question.id);
      deleteCategory(context.db, empty.id, 1);
    });
    const [item] = (await app.inject({ url: '/api/member/results', headers: { cookie: cleo } })).json().items;
    assert.equal(item.categoryId, null);
    assert.equal(item.categoryName, 'Brief');
    assert.deepEqual((await app.inject({ url: '/api/member/stats', headers: { cookie: cleo } })).json(), []);
  });

  it('clears only the caller\'s history, and deleting a member deletes theirs', async () => {
    const before = (await as('ada', 'GET', '/api/member/results')).json().items.length;
    assert.ok(before > 0);
    const cleared = await as('bob', 'DELETE', '/api/member/results');
    assert.equal(cleared.statusCode, 204);
    assert.deepEqual((await as('bob', 'GET', '/api/member/results')).json().items, []);
    assert.equal((await as('ada', 'GET', '/api/member/results')).json().items.length, before);

    const doomed = await createMember(context, 'r.doomed', 'Player');
    const cookie = await memberCookie(context, 'r.doomed');
    await app.inject({ method: 'POST', url: '/api/member/results', headers: { cookie, ...csrf }, payload: { categoryId: space.category.id, length: 'all', answers: [answer(space.questions[0])] } });
    const count = () => (context.db.connection.prepare('SELECT count(*) AS n FROM quiz_results WHERE member_id = ?').get(doomed.id) as { n: number }).n;
    assert.equal(count(), 1);
    await withDataWrite(context.operations, () => new AdminMemberService(context).delete(doomed.id));
    assert.equal(count(), 0);
  });

  it('needs a member session: visitors and the Admin cookie get 401', async () => {
    const admin = await adminCookie(context);
    for (const headers of [{}, { cookie: admin }]) {
      assert.equal((await app.inject({ url: '/api/member/results', headers })).statusCode, 401);
      assert.equal((await app.inject({ method: 'POST', url: '/api/member/results', headers: { ...headers, ...csrf }, payload: { categoryId: space.category.id, length: 'all', answers: [] } })).statusCode, 401);
    }
    const noCsrf = await app.inject({ method: 'DELETE', url: '/api/member/results', headers: { cookie: cookies.ada } });
    assert.equal(noCsrf.json().error, 'csrf');
  });

  it('audits a saved result by category, length and score, never the answers (LOG-14)', async () => {
    const response = await submit('ada', [answer(space.questions[0])]);
    const { id } = response.json().result;
    const entry = context.logs.listAudit({}, null, 200).find((candidate) => candidate.targetId === id)!;
    assert.equal(entry.action, 'createResult');
    assert.equal(entry.actorType, 'member');
    assert.deepEqual(entry.details, { categoryId: space.category.id, length: 'short', score: 1, total: 1 });
    assert.doesNotMatch(JSON.stringify(entry), new RegExp(space.questions[0].choices[0].id));
  });
});
