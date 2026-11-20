import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { ATTEMPT_KEY_NAME, ATTEMPT_TTL_MS, ensureAttemptKey } from '../attempts.js';
import { buildApp } from '../app.js';
import { withDataWrite } from '../dataWrite.js';
import { openDatabase } from '../db.js';
import { AdminMemberService } from '../members.js';
import { deleteCategory, insertCategory } from '../repository/categories.js';
import { insertQuestion, type Question } from '../repository/questions.js';
import { insertResult } from '../repository/results.js';
import { getSecret } from '../repository/secrets.js';
import { publicQuiz } from '../quizRoutes.js';
import { ResultService } from '../results.js';
import type { MemberSession, PublicQuiz } from '../../src/lib/api.js';
import { adminCookie, createMember, memberCookie, sampleQuestion, seedQuiz, testContext, totalChanges } from './helpers.js';

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
    assert.deepEqual(entry.details, { categoryId: space.category.id, length: 'short', score: 1, total: 1, attempt: 'none' });
    assert.doesNotMatch(JSON.stringify(entry), new RegExp(space.questions[0].choices[0].id));
  });
});

describe('signed quiz attempts (#45)', () => {
  const context = testContext();
  let app: FastifyInstance;
  let space: Awaited<ReturnType<typeof seedQuiz>>;
  let biologyId: string;
  const cookies: Record<'cleo' | 'dan', string> = {} as never;

  before(async () => {
    app = buildApp(context);
    await app.ready();
    space = await seedQuiz(context, 4);
    biologyId = (await withDataWrite(context.operations, () => insertCategory(context.db, { shortName: 'bio', name: 'Biology', description: 'd', priority: 20 }))).id;
    await withDataWrite(context.operations, () => insertQuestion(context.db, sampleQuestion(biologyId, 'Cells?')));
    for (const key of ['cleo', 'dan'] as const) {
      await createMember(context, `a.${key}`, 'Player');
      cookies[key] = await memberCookie(context, `a.${key}`);
    }
  });
  after(async () => { await app.close(); context.close(); });

  const draw = async (length = 'all', categoryId = space.category.id) => (await app.inject(`/api/categories/${categoryId}/quiz?length=${length}`)).json() as PublicQuiz;
  /** Right answers to every question of `quiz`, in the order drawn. */
  const answersFor = (quiz: PublicQuiz) => quiz.questions.map((question) => ({ questionId: question.id, choiceIds: question.correctChoiceIds }));
  const save = (key: keyof typeof cookies, body: object) => app.inject({
    method: 'POST', url: '/api/member/results', headers: { cookie: cookies[key], ...csrf }, payload: body,
  });
  const body = (quiz: PublicQuiz, overrides: Record<string, unknown> = {}) => ({
    categoryId: quiz.category.id, length: quiz.length, attemptToken: quiz.attempt.token, answers: answersFor(quiz), ...overrides,
  });
  const history = async (key: keyof typeof cookies) => (await app.inject({ url: '/api/member/results', headers: { cookie: cookies[key] } })).json().items as { id: string }[];
  const reason = (response: { statusCode: number; json(): { error: string; params?: { reason?: string } } }) => [response.statusCode, response.json().error, response.json().params?.reason];

  it('gives every drawn quiz a new signed attempt, and drawing writes nothing (BAK-8)', async () => {
    const before = totalChanges(context);
    const [first, second] = [await draw(), await draw()];
    assert.equal(totalChanges(context), before);
    assert.notEqual(first.attempt.id, second.attempt.id);
    assert.match(first.attempt.token, /^v1\.[\w-]+\.[\w-]+$/);
    const expires = Date.parse(first.attempt.expiresAt) - Date.now();
    assert.ok(expires > ATTEMPT_TTL_MS - 60_000 && expires <= ATTEMPT_TTL_MS, 'a day to save it');
    // The key never leaves the server.
    const key = getSecret(context.db, ATTEMPT_KEY_NAME)!;
    assert.ok(key.length >= 43);
    assert.doesNotMatch(JSON.stringify(first), new RegExp(key));
  });

  it('saves an attempt once: sending it again returns the saved result with 200', async () => {
    const quiz = await draw();
    const saved = await save('cleo', body(quiz));
    assert.equal(saved.statusCode, 201, saved.body);
    assert.equal(saved.json().result.score, 4);
    const again = await save('cleo', body(quiz));
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().result.id, saved.json().result.id);
    assert.equal((await history('cleo')).filter((item) => item.id === saved.json().result.id).length, 1);
    assert.equal((await history('cleo')).length, 1);
    // Another member cannot save someone else's attempt.
    assert.deepEqual(reason(await save('dan', body(quiz))), [409, 'conflict', undefined]);
    const entries = context.logs.listAudit({}, null, 200).filter((entry) => entry.action === 'createResult' && entry.targetId === saved.json().result.id);
    assert.deepEqual(entries.map((entry) => entry.details.attempt).sort(), ['repeated', 'verified']);
  });

  it('refuses a subset, extra, reordered or changed answers, and another category or length (mismatch)', async () => {
    const quiz = await draw();
    const answers = answersFor(quiz);
    for (const changed of [
      { answers: answers.slice(1) },
      { answers: [...answers].reverse() },
      { answers: answers.slice(0, 1) },
      { length: 'long' },
    ]) {
      assert.deepEqual(reason(await save('dan', body(quiz, changed))), [400, 'attempt_invalid', 'mismatch'], JSON.stringify(changed));
    }
    const biology = await draw('all', biologyId);
    assert.deepEqual(reason(await save('dan', body(quiz, { categoryId: biologyId, answers: answersFor(biology) }))), [400, 'attempt_invalid', 'mismatch']);
    // Wrong answers to the right questions are fine: they are graded, not refused.
    const wrong = await save('dan', body(quiz, { answers: answers.map((entry) => ({ ...entry, choiceIds: [] })) }));
    assert.equal(wrong.statusCode, 201, wrong.body);
    assert.equal(wrong.json().result.score, 0);
  });

  it('refuses a token it did not sign or that was changed (invalid)', async () => {
    const quiz = await draw();
    const [version, payload, signature] = quiz.attempt.token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const forged = Buffer.from(JSON.stringify({ ...claims, length: 'short' })).toString('base64url');
    const flipped = `${signature.slice(0, -2)}${signature.endsWith('AA') ? 'BB' : 'AA'}`;
    for (const token of [`${version}.${forged}.${signature}`, `${version}.${payload}.${flipped}`, `v2.${payload}.${signature}`, 'nonsense', `${quiz.attempt.token}.x`]) {
      assert.deepEqual(reason(await save('dan', body(quiz, { attemptToken: token }))), [400, 'attempt_invalid', 'invalid'], token);
    }
    // A token another installation signed (another key) is not this server's.
    const other = testContext();
    try {
      const elsewhere = await withDataWrite(other.operations, () => insertCategory(other.db, { shortName: 'space', name: 'Space', description: 'd', priority: 10 }));
      await withDataWrite(other.operations, () => insertQuestion(other.db, sampleQuestion(elsewhere.id, 'Elsewhere?')));
      const foreign = publicQuiz(other, elsewhere.id, 'all');
      assert.deepEqual(reason(await save('dan', body(quiz, { attemptToken: foreign.attempt.token }))), [400, 'attempt_invalid', 'invalid']);
    } finally {
      other.close();
    }
  });

  it('refuses an attempt older than a day (expired)', async () => {
    const quiz = await draw();
    const session = (await app.inject({ url: '/api/member/session', headers: { cookie: cookies.dan } })).json() as MemberSession;
    const later = () => new Date(Date.now() + ATTEMPT_TTL_MS + 60_000);
    await withDataWrite(context.operations, () => {
      // The service, with a clock a day ahead: the route has no clock to turn.
      assert.throws(() => new ResultService(context, session, later).submit(body(quiz) as never), (error: { statusCode: number; error: string; params: { reason: string } }) => (
        error.statusCode === 400 && error.error === 'attempt_invalid' && error.params.reason === 'expired'
      ));
    });
  });

  it('still saves a result without a token, as before (deprecated until 3.0.0)', async () => {
    const quiz = await draw();
    const response = await save('dan', { categoryId: quiz.category.id, length: quiz.length, answers: answersFor(quiz) });
    assert.equal(response.statusCode, 201, response.body);
  });
});

describe('the quiz attempt key (SEC-8, #45)', () => {
  it('is created once, kept across restarts, and created again for a database without one', () => {
    const context = testContext('', { file: true });
    const file = join(context.dataDir, 'agt-trivia.sqlite');
    try {
      const key = getSecret(context.db, ATTEMPT_KEY_NAME);
      assert.ok(key);
      assert.equal(ensureAttemptKey(context.db), false, 'an existing key is kept');
      context.db.close();
      const reopened = openDatabase(file).db;
      try {
        assert.equal(getSecret(reopened, ATTEMPT_KEY_NAME), key);
        reopened.connection.prepare('DELETE FROM app_secrets').run();
        assert.equal(ensureAttemptKey(reopened), true);
        const fresh = getSecret(reopened, ATTEMPT_KEY_NAME);
        assert.ok(fresh && fresh !== key);
      } finally {
        reopened.close();
      }
    } finally {
      context.close();
    }
  });
});
