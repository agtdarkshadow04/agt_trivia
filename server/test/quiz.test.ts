import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { withDataWrite } from '../dataWrite.js';
import { publicQuiz } from '../quizRoutes.js';
import { categoryConflicts, getCategory, insertCategory, listCategories } from '../repository/categories.js';
import { approvedQuestions, getQuestion, insertQuestion } from '../repository/questions.js';
import { adminCookie, sampleQuestion, seedQuiz, testContext } from './helpers.js';

/** Categories and questions (#15): the tables, the repository and the public quiz reads. */

const at = '2026-01-01T00:00:00.000Z';

describe('the categories and questions tables', () => {
  const context = testContext();
  after(() => context.close());
  const sqlite = () => context.db.connection;
  const insert = (id: string, shortName: string, name: string) => sqlite().prepare(`INSERT INTO categories
    (id, short_name, name, description, priority, version, created_at, updated_at) VALUES (?, ?, ?, 'd', 0, 1, ?, ?)`).run(id, shortName, name, at, at);

  it('keeps short names and names unique ignoring case, and short names to letters, digits and -', () => {
    insert(randomUUID(), 'Space', 'Space travel');
    assert.throws(() => insert(randomUUID(), 'SPACE', 'Other'), /UNIQUE/);
    assert.throws(() => insert(randomUUID(), 'other', 'space TRAVEL'), /UNIQUE/);
    assert.throws(() => insert(randomUUID(), 'with space', 'Third'), /CHECK/);
    assert.throws(() => insert(randomUUID(), 'x'.repeat(17), 'Fourth'), /CHECK/);
  });

  it('keeps choices unique per question ignoring case, at positions 0 to 3, and deletes them with their question', async () => {
    const { category, questions } = await seedQuiz(context, 1, { shortName: 'tables', name: 'Tables' });
    const question = questions[0];
    const choice = (position: number, text: string) => sqlite().prepare(`INSERT INTO question_choices
      (id, question_id, position, text, is_correct, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)`).run(randomUUID(), question.id, position, text, at, at);
    assert.throws(() => choice(2, 'APPROVED 1 (RIGHT)'), /UNIQUE/);
    assert.throws(() => choice(1, 'Another'), /UNIQUE/);
    assert.throws(() => choice(4, 'Another'), /CHECK/);
    // A category with questions cannot be deleted; a question's choices go with it.
    assert.throws(() => sqlite().prepare('DELETE FROM categories WHERE id = ?').run(category.id), /FOREIGN KEY/);
    sqlite().prepare('DELETE FROM questions WHERE id = ?').run(question.id);
    assert.equal((sqlite().prepare('SELECT count(*) AS n FROM question_choices WHERE question_id = ?').get(question.id) as { n: number }).n, 0);
  });

  it('refuses an unknown status and a question in an unknown category', () => {
    const question = (categoryId: string, status: string) => sqlite().prepare(`INSERT INTO questions (id, category_id, prompt, status,
      review_note, version, created_at, updated_at) VALUES (?, ?, 'Why?', ?, '', 1, ?, ?)`).run(randomUUID(), categoryId, status, at, at);
    const categoryId = (sqlite().prepare('SELECT id FROM categories LIMIT 1').get() as { id: string }).id;
    assert.throws(() => question(categoryId, 'published'), /CHECK/);
    assert.throws(() => question(randomUUID(), 'draft'), /FOREIGN KEY/);
  });
});

describe('the categories and questions repository', () => {
  const context = testContext();
  after(() => context.close());

  it('writes only inside a data write (BAK-8)', () => {
    assert.throws(() => insertCategory(context.db, { shortName: 'x', name: 'X', description: 'x', priority: 0 }), { name: 'DataWriteError' });
  });

  it('lists categories by priority, then name ignoring case and accents, counting approved questions only', async () => {
    await seedQuiz(context, 2, { shortName: 'space', name: 'Space', priority: 5 });
    await withDataWrite(context.operations, () => {
      insertCategory(context.db, { shortName: 'eco', name: 'écologie', description: 'd', priority: 5 });
      insertCategory(context.db, { shortName: 'first', name: 'Zeta', description: 'd', priority: 0 });
      insertCategory(context.db, { shortName: 'bio', name: 'Biology', description: 'd', priority: 5 });
    });
    const listed = listCategories(context.db);
    assert.deepEqual(listed.map((category) => category.name), ['Zeta', 'Biology', 'écologie', 'Space']);
    assert.deepEqual(listed.map((category) => category.questionCount), [0, 0, 0, 2]);
  });

  it('finds name conflicts ignoring case in any script, except the category itself', () => {
    const eco = listCategories(context.db).find((category) => category.shortName === 'eco')!;
    assert.deepEqual(categoryConflicts(context.db, { shortName: 'ECO', name: 'ÉCOLOGIE' }), ['shortName', 'name']);
    assert.deepEqual(categoryConflicts(context.db, { shortName: 'ECO', name: 'ÉCOLOGIE' }, eco.id), []);
    assert.deepEqual(categoryConflicts(context.db, { shortName: 'new', name: 'New' }), []);
  });

  it('stores a question with its choices in order, and the approval only for approved ones', async () => {
    const category = listCategories(context.db).find((entry) => entry.shortName === 'bio')!;
    const now = new Date('2026-03-04T05:06:07.000Z');
    const [approved, draft] = await withDataWrite(context.operations, () => [
      insertQuestion(context.db, { ...sampleQuestion(category.id, 'Cells?'), choices: [
        { text: 'B', isCorrect: false }, { text: 'A', isCorrect: true }, { text: 'C', isCorrect: true },
      ], approvedBy: 'moderator-id' }, now),
      insertQuestion(context.db, sampleQuestion(category.id, 'Draft?', { status: 'draft', approvedBy: 'ignored' }), now),
    ]);
    assert.deepEqual(approved.choices.map((choice) => [choice.position, choice.text, choice.isCorrect]), [[0, 'B', false], [1, 'A', true], [2, 'C', true]]);
    assert.equal(approved.approvedAt, now.toISOString());
    assert.equal(approved.approvedBy, 'moderator-id');
    assert.equal(approved.version, 1);
    assert.equal(draft.approvedAt, null);
    assert.equal(draft.approvedBy, null);
    assert.deepEqual(getQuestion(context.db, draft.id), draft);
    assert.deepEqual(approvedQuestions(context.db, category.id).map((question) => question.id), [approved.id]);
    assert.equal(getCategory(context.db, category.id)!.questionCount, 1);
  });
});

describe('the public quiz reads (API-3)', () => {
  // Short quizzes of 2 and long ones of 3 questions, from config.yaml.
  const context = testContext('quiz:\n  shortLength: 2\n  longLength: 3\n');
  let app: FastifyInstance;
  let seeded: Awaited<ReturnType<typeof seedQuiz>>;
  before(async () => {
    app = buildApp(context);
    await app.ready();
    seeded = await seedQuiz(context, 4);
  });
  after(async () => { await app.close(); context.close(); });

  it('lists the categories without a session, with exactly the public fields', async () => {
    const response = await app.inject('/api/categories');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), [{
      id: seeded.category.id, shortName: 'space', name: 'Space', description: 'Questions about space.', priority: 10, questionCount: 4,
    }]);
  });

  it('draws short, long and full quizzes of approved questions only', async () => {
    const approvedIds = new Set(seeded.questions.map((question) => question.id));
    for (const [length, count] of [['short', 2], ['long', 3], ['all', 4]] as const) {
      const response = await app.inject(`/api/categories/${seeded.category.id}/quiz?length=${length}`);
      assert.equal(response.statusCode, 200, response.body);
      const quiz = response.json();
      assert.equal(quiz.length, length);
      assert.equal(quiz.category.id, seeded.category.id);
      assert.equal(quiz.questions.length, count);
      assert.equal(new Set(quiz.questions.map((question: { id: string }) => question.id)).size, count);
      for (const question of quiz.questions) assert.ok(approvedIds.has(question.id), 'only approved questions');
    }
  });

  it('sends only the public fields: never review notes, statuses or member IDs', async () => {
    const response = await app.inject(`/api/categories/${seeded.category.id}/quiz?length=all`);
    const [question] = response.json().questions;
    const stored = seeded.questions.find((entry) => entry.id === question.id)!;
    assert.deepEqual(question, {
      id: stored.id,
      prompt: stored.prompt,
      choices: stored.choices.map((choice) => ({ id: choice.id, text: choice.text })),
      correctChoiceIds: [stored.choices[0].id],
      authorCredit: null,
    });
    for (const secret of ['secret note', '11111111-1111-4111-8111-111111111111', 'Hidden', 'reviewNote', 'status', 'createdBy']) {
      assert.doesNotMatch(response.body, new RegExp(secret));
    }
  });

  it('gives a multi-answer question every correct choice, in the author\'s order', async () => {
    const question = await withDataWrite(context.operations, () => insertQuestion(context.db, {
      ...sampleQuestion(seeded.category.id, 'Gas giants?'),
      authorCredit: 'A traveller',
      choices: [{ text: 'Jupiter', isCorrect: true }, { text: 'Mars', isCorrect: false }, { text: 'Saturn', isCorrect: true }],
    }));
    const quiz = (await app.inject(`/api/categories/${seeded.category.id}/quiz?length=all`)).json();
    const served = quiz.questions.find((entry: { id: string }) => entry.id === question.id);
    assert.deepEqual(served.choices.map((choice: { text: string }) => choice.text), ['Jupiter', 'Mars', 'Saturn']);
    assert.deepEqual(served.correctChoiceIds, [question.choices[0].id, question.choices[2].id]);
    assert.equal(served.authorCredit, 'A traveller');
  });

  it('draws at random, and gives everything there is when the category has fewer questions', () => {
    const first = publicQuiz(context, seeded.category.id, 'short', () => 0).questions.map((question) => question.id);
    const last = publicQuiz(context, seeded.category.id, 'short', () => 0.999).questions.map((question) => question.id);
    assert.notDeepEqual(first, last);
    assert.equal(publicQuiz(context, seeded.category.id, 'all').questions.length, 5);
  });

  it('answers 404 for an unknown or malformed category, and accepts an uppercase ID', async () => {
    for (const id of [randomUUID(), 'not-a-uuid', '1']) {
      const response = await app.inject(`/api/categories/${id}/quiz?length=short`);
      assert.equal(response.statusCode, 404, id);
      assert.equal(response.json().error, 'not_found');
    }
    assert.equal((await app.inject(`/api/categories/${seeded.category.id.toUpperCase()}/quiz?length=short`)).statusCode, 200);
  });

  it('needs a valid length and nothing else in the query string (API-10)', async () => {
    for (const query of ['', '?length=medium', '?length=short&extra=1']) {
      const response = await app.inject(`/api/categories/${seeded.category.id}/quiz${query}`);
      assert.equal(response.statusCode, 400, query);
    }
  });

  it('is public in the OpenAPI document (API-11)', async () => {
    const paths = (await app.inject('/api/openapi.json')).json().paths;
    assert.deepEqual(paths['/api/categories'].get.security, []);
    assert.deepEqual(paths['/api/categories/{id}/quiz'].get.security, []);
  });
});

describe('categories and questions in backups (BAK-2, BAK-3)', () => {
  const context = testContext('', { file: true });
  let app: FastifyInstance;
  before(async () => { app = buildApp(context); await app.ready(); });
  after(async () => { await app.close(); context.close(); });

  it('backs them up, and the preview counts them', async () => {
    await seedQuiz(context, 2);
    const cookie = await adminCookie(context);
    const backup = await app.inject({ url: '/api/admin/backup', headers: { cookie } });
    assert.equal(backup.statusCode, 200);
    const boundary = 'quiz-test-boundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="action"\r\n\r\npreview\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="backup"; filename="b.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      backup.rawPayload,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const preview = await app.inject({
      method: 'POST', url: '/api/admin/restore', payload,
      headers: { cookie, 'x-agt-request': '1', 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.json().counts, { categories: 1, questions: 5, members: 0, admin: 1, settings: 0 });
  });
});
