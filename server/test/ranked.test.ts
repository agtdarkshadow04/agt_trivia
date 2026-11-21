import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { withDataWrite } from '../dataWrite.js';
import { RankedService } from '../ranked.js';
import { insertCategory } from '../repository/categories.js';
import { getMember, setLeaderboardOptIn, toSession, updateMember } from '../repository/members.js';
import { insertQuestion, type Question } from '../repository/questions.js';
import type { TestContext } from './helpers.js';
import { adminCookie, createMember, memberCookie, sampleQuestion, seedQuiz, testContext } from './helpers.js';

/**
 * Ranked mode (#66): the server draws, shows, times and grades every run, and
 * never says whether an answer was right; ratings, the board, the Admin's
 * categories, and who may do what.
 */

const csrf = { 'x-agt-request': '1' };
const config = (extra = '') => `ranked:\n  enabled: true\n  questionsPerRun: 3\n  secondsPerQuestion: 20\n${extra}`;

/** The correct choice IDs of a seeded question. */
const rightOf = (question: Question) => question.choices.filter((choice) => choice.isCorrect).map((choice) => choice.id);
const wrongOf = (question: Question) => question.choices.filter((choice) => !choice.isCorrect).map((choice) => choice.id).slice(0, 1);

/** Adds `count` approved questions to a new category, for a pool larger than one run. */
async function addCategory(context: TestContext, shortName: string, count: number) {
  return withDataWrite(context.operations, () => {
    const category = insertCategory(context.db, { shortName, name: `Category ${shortName}`, description: 'd', priority: 5 });
    const questions = Array.from({ length: count }, (_, index) => insertQuestion(context.db, sampleQuestion(category.id, `${shortName} ${index + 1}`)));
    return { category, questions };
  });
}

/** A service for `username` on a clock the test moves. */
function clocked(context: TestContext, username: string) {
  const id = (context.db.connection.prepare('SELECT id FROM members WHERE username = ?').get(username) as { id: string }).id;
  const clock = { now: new Date(Date.UTC(2031, 0, 1)) };
  const service = new RankedService(context, toSession(getMember(context.db, id)!), () => clock.now);
  const write = <T>(work: (ranked: RankedService) => T) => withDataWrite(context.operations, () => work(service));
  const advance = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
  return { id, clock, service, write, advance };
}

describe('ranked runs over HTTP (#66)', () => {
  // No cooldown: the same 4 questions serve every run of this suite.
  const context = testContext(config('  cooldownDays: 0\n'));
  let app: FastifyInstance;
  let questions: Question[];
  let player: string;
  const byPrompt = new Map<string, Question>();

  before(async () => {
    app = buildApp(context);
    await app.ready();
    ({ questions } = await seedQuiz(context, 4));
    for (const question of questions) byPrompt.set(question.prompt, question);
    await createMember(context, 'r.player', 'Player');
    await createMember(context, 'r.other', 'Player');
    player = await memberCookie(context, 'r.player');
  });
  after(async () => { await app.close(); context.close(); });

  const as = (cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => app.inject({
    method, url, headers: { cookie, ...(method === 'GET' ? {} : csrf) }, ...(payload ? { payload } : {}),
  });

  it('needs a member session and the CSRF header, and never takes the Admin session', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/api/member/ranked/runs', headers: csrf })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/member/ranked/runs', headers: { cookie: player } })).json().error, 'csrf');
    const admin = await adminCookie(context);
    assert.equal((await as(admin, 'POST', '/api/member/ranked/runs')).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/member/ranked/me' })).statusCode, 401);
  });

  it('plays a run to the end without ever saying which answers were right', async () => {
    const started = await as(player, 'POST', '/api/member/ranked/runs');
    assert.equal(started.statusCode, 201);
    const { run } = started.json();
    assert.deepEqual(started.json().notices, []);
    assert.equal(run.status, 'active');
    assert.equal(run.questionCount, 3);
    assert.equal(run.totals, null);

    const bodies: string[] = [];
    const prompts = new Set<string>();
    let right = 0;
    for (let position = 0; position < 3; position += 1) {
      const step = await as(player, 'POST', `/api/member/ranked/runs/${run.id}/next`);
      assert.equal(step.statusCode, 200);
      bodies.push(step.body);
      const { question } = step.json();
      assert.equal(question.position, position);
      assert.equal(question.multi, false);
      assert.deepEqual(Object.keys(question.choices[0]).sort(), ['id', 'text']);
      assert.equal(Date.parse(question.deadline) - Date.parse(question.servedAt), 20_000);
      assert.ok(question.remainingMs > 19_000 && question.remainingMs <= 20_000);
      prompts.add(question.prompt);
      // The first two answered right, the last wrong.
      const seeded = byPrompt.get(question.prompt)!;
      const choiceIds = position < 2 ? rightOf(seeded) : wrongOf(seeded);
      if (position < 2) right += 1;
      const answered = await as(player, 'POST', `/api/member/ranked/runs/${run.id}/answers`, { position, choiceIds });
      assert.equal(answered.statusCode, 200);
      bodies.push(answered.body);
      assert.equal(answered.json().late, false);
      assert.deepEqual(Object.keys(answered.json()).sort(), ['late', 'run']);
      if (position < 2) assert.equal(answered.json().run.totals, null, 'no totals while the run is active');
    }
    assert.equal(prompts.size, 3, 'three different questions');
    // Nothing until the end says what was right: no correct flags, correct choices or running score.
    for (const body of bodies.slice(0, -1)) assert.doesNotMatch(body, /isCorrect|correctChoiceIds|"correct"|"score"|"points"/);

    const finished = (await as(player, 'GET', `/api/member/ranked/runs/${run.id}`)).json();
    assert.equal(finished.status, 'finished');
    assert.equal(finished.closedCount, 3);
    assert.equal(finished.totals.correctCount, right);
    assert.equal(finished.totals.countedCount, 3);
    // Two correct answers in a row: at least 2 × 100, plus the streak bonus of the second.
    assert.ok(finished.totals.score >= 210 && finished.totals.score <= 310, String(finished.totals.score));
    assert.equal(finished.totals.rating, finished.totals.score);
    assert.equal(finished.totals.ratingChange, null);
    assert.equal((await as(player, 'POST', `/api/member/ranked/runs/${run.id}/next`)).json().error, 'run_not_active');

    const mine = (await as(player, 'GET', '/api/member/ranked/me')).json();
    assert.equal(mine.enabled, true);
    assert.equal(mine.rating, finished.totals.score);
    assert.equal(mine.runs, 1);
    assert.equal(mine.provisional, true);
    assert.equal(mine.rank, null);
    assert.equal(mine.activeRunId, null);
    assert.deepEqual(mine.history.map((entry: { id: string; status: string }) => [entry.id, entry.status]), [[run.id, 'finished']]);
  });

  it('takes only the first answer to the question being shown, and shows it again with the same deadline', async () => {
    const { run } = (await as(player, 'POST', '/api/member/ranked/runs')).json();
    const early = await as(player, 'POST', `/api/member/ranked/runs/${run.id}/answers`, { position: 0, choiceIds: [questions[0].choices[0].id] });
    assert.equal(early.json().error, 'question_not_current', 'nothing to answer before it is shown');
    const first = (await as(player, 'POST', `/api/member/ranked/runs/${run.id}/next`)).json().question;
    const again = (await as(player, 'POST', `/api/member/ranked/runs/${run.id}/next`)).json().question;
    assert.equal(again.position, 0);
    assert.equal(again.deadline, first.deadline, 'asking again does not restart the time');
    assert.ok(again.remainingMs <= first.remainingMs);
    const seeded = byPrompt.get(first.prompt)!;
    assert.equal((await as(player, 'POST', `/api/member/ranked/runs/${run.id}/answers`, { position: 1, choiceIds: rightOf(seeded) })).json().error, 'question_not_current');
    assert.equal((await as(player, 'POST', `/api/member/ranked/runs/${run.id}/answers`, { position: 0, choiceIds: [] })).json().fields[0].code, 'too_few');
    const foreign = byPrompt.get([...byPrompt.keys()].find((prompt) => prompt !== first.prompt)!)!;
    assert.equal((await as(player, 'POST', `/api/member/ranked/runs/${run.id}/answers`, { position: 0, choiceIds: rightOf(foreign) })).json().fields[0].code, 'not_allowed');
    assert.equal((await as(player, 'POST', `/api/member/ranked/runs/${run.id}/answers`, { position: 0, choiceIds: rightOf(seeded) })).statusCode, 200);
    assert.equal((await as(player, 'POST', `/api/member/ranked/runs/${run.id}/answers`, { position: 0, choiceIds: wrongOf(seeded) })).json().error, 'question_not_current', 'the first answer is final');
    // Undeclared properties are refused by the schema.
    assert.equal((await as(player, 'POST', `/api/member/ranked/runs/${run.id}/answers`, { position: 1, choiceIds: [], correct: true })).statusCode, 400);
  });

  it("keeps one active run per member, forfeits it on a new start, and hides other members' runs", async () => {
    const { run: open } = (await as(player, 'POST', '/api/member/ranked/runs')).json();
    assert.equal((await as(player, 'GET', '/api/member/ranked/me')).json().activeRunId, open.id);
    const other = await memberCookie(context, 'r.other');
    assert.equal((await as(other, 'GET', `/api/member/ranked/runs/${open.id}`)).statusCode, 404);
    assert.equal((await as(other, 'POST', `/api/member/ranked/runs/${open.id}/next`)).statusCode, 404);
    assert.equal((await as(player, 'GET', '/api/member/ranked/runs/not-a-uuid')).statusCode, 404);
    const { run: fresh } = (await as(player, 'POST', '/api/member/ranked/runs')).json();
    const forfeited = (await as(player, 'GET', `/api/member/ranked/runs/${open.id}`)).json();
    assert.equal(forfeited.status, 'forfeited');
    assert.equal(forfeited.totals.score, 0);
    assert.equal(forfeited.totals.countedCount, 3);
    assert.equal((await as(player, 'GET', '/api/member/ranked/me')).json().activeRunId, fresh.id);
  });

  it('audits each step by run and position, never the answers chosen', async () => {
    const { run } = (await as(player, 'POST', '/api/member/ranked/runs')).json();
    const { question } = (await as(player, 'POST', `/api/member/ranked/runs/${run.id}/next`)).json();
    const choiceIds = rightOf(byPrompt.get(question.prompt)!);
    await as(player, 'POST', `/api/member/ranked/runs/${run.id}/answers`, { position: 0, choiceIds });
    const entries = context.logs.listAudit({}, null, 500).filter((entry) => entry.targetId === run.id);
    assert.deepEqual(entries.map((entry) => entry.action).sort(), ['answerRankedQuestion', 'nextRankedQuestion', 'startRankedRun']);
    for (const entry of entries) {
      assert.equal(entry.actorType, 'member');
      assert.doesNotMatch(JSON.stringify(entry), new RegExp(choiceIds[0]));
    }
  });
});

describe('ranked timing and scoring (#66)', () => {
  const context = testContext(config());
  let questions: Question[];
  const byId = new Map<string, Question>();
  const byPrompt = new Map<string, Question>();
  before(async () => {
    ({ questions } = await seedQuiz(context, 3));
    for (const question of questions) { byId.set(question.id, question); byPrompt.set(question.prompt, question); }
    for (const name of ['t.fast', 't.slow', 't.gone']) await createMember(context, name);
  });
  after(() => context.close());

  it('adds a speed bonus falling to 0 at the limit, and a streak bonus for answers in a row', async () => {
    const { write, advance } = clocked(context, 't.fast');
    const run = await write((ranked) => ranked.start());
    const elapsed = [0, 10_000, 20_000];
    for (const ms of elapsed) {
      const { question } = await write((ranked) => ranked.next(run.id));
      advance(ms);
      await write((ranked) => ranked.answer(run.id, question!.position, rightOf(byPrompt.get(question!.prompt)!)));
    }
    const { totals } = await write((ranked) => ranked.get(run.id));
    // 150 + (125 + 10) + (100 + 20).
    assert.equal(totals!.score, 405);
    assert.equal(totals!.correctCount, 3);
    assert.equal(totals!.averageAnswerMs, 10_000);
  });

  it('scores a late answer 0, expires an unanswered question, and lets a miss end the streak', async () => {
    const { write, advance } = clocked(context, 't.slow');
    const run = await write((ranked) => ranked.start());
    // In time, right: 150. Within the 2-second allowance, right: 100, no streak bonus after a late answer.
    let { question } = await write((ranked) => ranked.next(run.id));
    await write((ranked) => ranked.answer(run.id, question!.position, rightOf(byPrompt.get(question!.prompt)!)));
    ({ question } = await write((ranked) => ranked.next(run.id)));
    advance(22_500);
    const late = await write((ranked) => ranked.answer(run.id, question!.position, rightOf(byPrompt.get(question!.prompt)!)));
    assert.equal(late.late, true);
    // The third question is shown, then never answered: asking again after its time expires it and ends the run.
    await write((ranked) => ranked.next(run.id));
    advance(30_000);
    const last = await write((ranked) => ranked.next(run.id));
    assert.equal(last.question, null);
    assert.equal(last.run.status, 'finished');
    assert.equal(last.run.totals!.score, 150);
    assert.equal(last.run.totals!.correctCount, 1);
    assert.equal(last.run.totals!.averageAnswerMs, 0);
  });

  it('leaves out a question unapproved during the run, without counting it', async () => {
    const { write } = clocked(context, 't.gone');
    const run = await write((ranked) => ranked.start());
    const { question } = await write((ranked) => ranked.next(run.id));
    const target = byPrompt.get(question!.prompt)!;
    await withDataWrite(context.operations, () => context.db.connection.prepare("UPDATE questions SET status = 'draft' WHERE id = ?").run(target.id));
    try {
      const answered = await write((ranked) => ranked.answer(run.id, question!.position, rightOf(target)));
      assert.equal(answered.late, false);
      for (let index = 0; index < 2; index += 1) {
        const step = await write((ranked) => ranked.next(run.id));
        await write((ranked) => ranked.answer(run.id, step.question!.position, rightOf(byPrompt.get(step.question!.prompt)!)));
      }
      const { totals } = await write((ranked) => ranked.get(run.id));
      assert.equal(totals!.countedCount, 2);
      assert.equal(totals!.correctCount, 2);
    } finally {
      await withDataWrite(context.operations, () => context.db.connection.prepare("UPDATE questions SET status = 'approved' WHERE id = ?").run(target.id));
    }
  });

  it('deletes a member\'s runs with the member', async () => {
    const { id } = clocked(context, 't.gone');
    const before = (context.db.connection.prepare('SELECT count(*) AS count FROM ranked_runs WHERE member_id = ?').get(id) as { count: number }).count;
    assert.ok(before > 0);
    await withDataWrite(context.operations, () => context.db.connection.prepare('DELETE FROM members WHERE id = ?').run(id));
    assert.equal((context.db.connection.prepare('SELECT count(*) AS count FROM ranked_runs WHERE member_id = ?').get(id) as { count: number }).count, 0);
    assert.equal((context.db.connection.prepare('SELECT count(*) AS count FROM ranked_answers WHERE run_id NOT IN (SELECT id FROM ranked_runs)').get() as { count: number }).count, 0);
  });
});

describe("the ranked draw: the Admin's categories and the cooldown (#66)", () => {
  const context = testContext(config('  cooldownDays: 14\n'));
  let app: FastifyInstance;
  let admin: Record<string, string>;
  before(async () => {
    app = buildApp(context);
    await app.ready();
    admin = { cookie: await adminCookie(context), ...csrf };
    await createMember(context, 'd.member');
  });
  after(async () => { await app.close(); context.close(); });

  it('refuses to start with too few questions in the included categories', async () => {
    const { write } = clocked(context, 'd.member');
    await addCategory(context, 'small', 2);
    await assert.rejects(write((ranked) => ranked.start()), (error: { error: string; params: { reason: string } }) => error.error === 'ranked_unavailable' && error.params.reason === 'too_few_questions');
  });

  it("draws only from the categories the Admin includes, every category by default", async () => {
    const big = await addCategory(context, 'big', 6);
    const listed = (await app.inject({ url: '/api/admin/ranked/categories', headers: { cookie: admin.cookie } })).json();
    assert.deepEqual(listed.map((category: { shortName: string; ranked: boolean; questionCount: number }) => [category.shortName, category.ranked, category.questionCount]), [['big', true, 6], ['small', true, 2]]);
    const small = listed.find((category: { shortName: string }) => category.shortName === 'small');
    const changed = await app.inject({ method: 'PUT', url: '/api/admin/ranked/categories', headers: admin, payload: { categories: [{ id: small.id, ranked: false }] } });
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json().categories.find((category: { id: string }) => category.id === small.id).ranked, false);
    const audit = context.logs.listAudit({}, null, 200).find((entry) => entry.action === 'replaceRankedCategories')!;
    assert.equal(audit.outcome, 'success');
    const { write } = clocked(context, 'd.member');
    const run = await write((ranked) => ranked.start());
    const drawn = context.db.connection.prepare('SELECT category_id AS categoryId FROM ranked_answers WHERE run_id = ?').all(run.id) as { categoryId: string }[];
    assert.ok(drawn.every((row) => row.categoryId === big.category.id));
    // Unknown categories and members are refused.
    const unknown = await app.inject({ method: 'PUT', url: '/api/admin/ranked/categories', headers: admin, payload: { categories: [{ id: '00000000-0000-4000-8000-000000000000', ranked: true }] } });
    assert.equal(unknown.json().fields[0].code, 'not_allowed');
    const member = await memberCookie(context, 'd.member');
    assert.equal((await app.inject({ url: '/api/admin/ranked/categories', headers: { cookie: member } })).statusCode, 401);
  });

  it('leaves out the questions a member was shown within the cooldown', async () => {
    // 6 included questions, 3 a run: two runs see all of them, and a third must wait.
    const { write, advance } = clocked(context, 'd.member');
    await withDataWrite(context.operations, () => context.db.connection.prepare('DELETE FROM ranked_runs').run());
    const seen = new Set<string>();
    for (let run = 0; run < 2; run += 1) {
      const started = await write((ranked) => ranked.start());
      for (let position = 0; position < 3; position += 1) {
        const { question } = await write((ranked) => ranked.next(started.id));
        seen.add(question!.prompt);
        await write((ranked) => ranked.answer(started.id, question!.position, [question!.choices[0].id]));
      }
    }
    assert.equal(seen.size, 6, 'no question twice within the cooldown');
    await assert.rejects(write((ranked) => ranked.start()), (error: { params: { reason: string } }) => error.params.reason === 'cooldown');
    advance(15 * 86_400_000);
    assert.equal((await write((ranked) => ranked.start())).status, 'active');
  });
});

describe('the ranked board (#66)', () => {
  const context = testContext(config('  boardSize: 3\n  cooldownDays: 0\n'));
  let app: FastifyInstance;
  const byPrompt = new Map<string, Question>();
  before(async () => {
    app = buildApp(context);
    await app.ready();
    const { questions } = await seedQuiz(context, 3);
    for (const question of questions) byPrompt.set(question.prompt, question);
    for (const name of ['b.ace', 'b.good', 'b.new', 'b.hidden', 'b.away']) await createMember(context, name);
  });
  after(async () => { await app.close(); context.close(); });

  /** Plays `runs` runs for a member, answering `right` questions of each right, instantly. */
  async function play(username: string, runs: number, right: number) {
    const { write } = clocked(context, username);
    for (let index = 0; index < runs; index += 1) {
      const run = await write((ranked) => ranked.start());
      for (let position = 0; position < 3; position += 1) {
        const { question } = await write((ranked) => ranked.next(run.id));
        const seeded = byPrompt.get(question!.prompt)!;
        await write((ranked) => ranked.answer(run.id, question!.position, position < right ? rightOf(seeded) : wrongOf(seeded)));
      }
    }
  }

  it('is closed while Ranked mode is off', async () => {
    const closed = testContext();
    const closedApp = buildApp(closed);
    try {
      assert.equal((await closedApp.inject('/api/ranked/leaderboard')).json().error, 'ranked_closed');
    } finally {
      await closedApp.close();
      closed.close();
    }
  });

  it('ranks opted-in active members by rating, lists newcomers as provisional, and shows display names only', async () => {
    await play('b.ace', 3, 3);
    await play('b.good', 3, 2);
    await play('b.new', 1, 3);
    await play('b.hidden', 3, 3);
    await play('b.away', 3, 3);
    const ids = Object.fromEntries(['b.ace', 'b.good', 'b.new', 'b.away'].map((name) => [name, clocked(context, name).id]));
    await withDataWrite(context.operations, () => {
      for (const id of Object.values(ids)) setLeaderboardOptIn(context.db, id, true);
      const away = getMember(context.db, ids['b.away'])!;
      updateMember(context.db, away.id, { displayName: away.displayName, role: away.role, isActive: false });
    });
    const board = (await app.inject('/api/ranked/leaderboard')).json();
    assert.equal(board.ratingRuns, 10);
    assert.equal(board.provisionalRuns, 3);
    assert.deepEqual(board.entries.map((entry: { rank: number; displayName: string; runs: number; accuracy: number }) => [entry.rank, entry.displayName, entry.runs, entry.accuracy]), [
      [1, 'Display b.ace', 3, 100],
      [2, 'Display b.good', 3, 67],
    ]);
    assert.ok(board.entries[0].rating > board.entries[1].rating);
    assert.deepEqual(board.provisional.map((entry: { displayName: string; runs: number }) => [entry.displayName, entry.runs]), [['Display b.new', 1]]);
    // No usernames, IDs or anything else about the members (API-3).
    assert.doesNotMatch(JSON.stringify(board), /"b\.ace"|username|memberId|"id"/);
    for (const entry of board.entries) assert.deepEqual(Object.keys(entry).sort(), ['accuracy', 'displayName', 'rank', 'rating', 'runs']);

    // The member's own view: their rank once ranked, none while provisional.
    const ace = await memberCookie(context, 'b.ace');
    assert.equal((await app.inject({ url: '/api/member/ranked/me', headers: { cookie: ace } })).json().rank, 1);
    const fresh = await memberCookie(context, 'b.new');
    const mine = (await app.inject({ url: '/api/member/ranked/me', headers: { cookie: fresh } })).json();
    assert.equal(mine.provisional, true);
    assert.equal(mine.rank, null);
  });
});
