import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { withDataWrite } from '../dataWrite.js';
import { insertCategory, listCategories } from '../repository/categories.js';
import { maxImportFileBytes } from '../sheetImport.js';
import { adminCookie, createMember, memberCookie, testContext, totalChanges } from './helpers.js';

/** The Admin's import of the 1.x sheet (#22), with fixtures cut from the sheet's own CSV downloads. */

const csrf = { 'x-agt-request': '1' };
const categoriesCsv = readFileSync('tests/fixtures/sheet/validCategories.csv');
const questionsCsv = readFileSync('tests/fixtures/sheet/pendingQuestions.csv');
const header = 'category,isApproved,adminNotes,isMultiAnswer,question,answers,correctAnswer,author';

interface Part { name: string; content: Buffer | string; type?: string }

/** A `multipart/form-data` body with the `action` field and the given files. */
function multipart(action: string, files: Part[]) {
  const boundary = `----agt${randomUUID()}`;
  const parts: Buffer[] = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="action"\r\n\r\n${action}\r\n`)];
  for (const file of files) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.name}.csv"\r\nContent-Type: ${file.type ?? 'text/csv'}\r\n\r\n`),
      Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content),
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** Every file under a directory, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => `${entry.parentPath}/${entry.name}`).sort();
}

describe('the sheet import', () => {
  const context = testContext();
  let app: FastifyInstance;
  let cookie: string;
  before(async () => {
    app = buildApp(context);
    await app.ready();
    cookie = await adminCookie(context);
  });
  after(async () => { await app.close(); context.close(); });

  const upload = (action: string, files: Part[], headers: Record<string, string> = { cookie, ...csrf }) => {
    const body = multipart(action, files);
    return app.inject({ method: 'POST', url: '/api/admin/import', headers: { ...headers, ...body.headers }, payload: body.payload });
  };
  const sheet: Part[] = [{ name: 'categories', content: categoriesCsv }, { name: 'questions', content: questionsCsv }];

  it('is the Admin\'s alone: visitors and members get 401, and the CSRF header is required', async () => {
    await createMember(context, 'i.moderator', 'Moderator');
    const member = await memberCookie(context, 'i.moderator');
    assert.equal((await upload('preview', sheet, csrf)).statusCode, 401);
    assert.equal((await upload('preview', sheet, { cookie: member, ...csrf })).statusCode, 401);
    const noCsrf = await upload('preview', sheet, { cookie });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(noCsrf.json().error, 'csrf');
  });

  it('previews the sheet without writing anything', async () => {
    const before = totalChanges(context);
    const response = await upload('preview', sheet);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      action: 'preview', imported: false,
      categories: { create: 3, skip: 0 },
      questions: { create: 11, skip: 0, approved: 11, pending: 0 },
      problems: [],
    });
    assert.equal(totalChanges(context), before);
  });

  it('imports it in one go, and a second import adds nothing', async () => {
    const response = await upload('import', sheet);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().imported, true);
    const categories = listCategories(context.db);
    assert.deepEqual(categories.map((category) => [category.shortName, category.questionCount]), [['AGT', 3], ['HTF', 8], ['NMS', 0]]);
    const multi = context.db.connection.prepare("SELECT * FROM questions WHERE prompt = 'Which group is the HTF a member of?'").get() as Record<string, unknown>;
    assert.equal(multi.status, 'approved');
    assert.equal(multi.author_credit, 'AGTDarkShadow04');
    assert.equal(multi.created_by, null);
    assert.ok(multi.approved_at);
    const choices = context.db.connection.prepare('SELECT text, is_correct FROM question_choices WHERE question_id = ? ORDER BY position').all(multi.id as string) as { text: string; is_correct: number }[];
    assert.deepEqual(choices.map((choice) => [choice.text, choice.is_correct]), [
      ['Alliance of Galactic Travellers', 1], ['Intergalactic Travellers Foundation', 1], ['United Federation of Travellers', 0], ['Galactic Hub', 0],
    ]);
    const again = await upload('import', sheet);
    assert.deepEqual(again.json(), {
      action: 'import', imported: true,
      categories: { create: 0, skip: 3 },
      questions: { create: 0, skip: 11, approved: 0, pending: 0 },
      problems: [],
    });
    assert.equal(listCategories(context.db).length, 3);
  });

  it('imports unapproved questions as pending with their notes, into existing categories matched by name', async () => {
    const questions = `${header}\nno man's SKY,FALSE,NEEDS APPROVAL,FALSE,What is the Atlas?,"An entity, A ship",An entity,Luna\n,FALSE,,,,,,\n`;
    const preview = (await upload('preview', [{ name: 'questions', content: questions }])).json();
    assert.deepEqual(preview.questions, { create: 1, skip: 0, approved: 0, pending: 1 });
    await upload('import', [{ name: 'questions', content: questions, type: 'text/plain' }]);
    const row = context.db.connection.prepare("SELECT status, review_note, approved_at FROM questions WHERE prompt = 'What is the Atlas?'").get();
    assert.deepEqual({ ...row as object }, { status: 'pending', review_note: 'NEEDS APPROVAL', approved_at: null });
  });

  it('reports every bad row with its file, row and column, and then imports nothing', async () => {
    await withDataWrite(context.operations, () => insertCategory(context.db, { shortName: 'TAKEN', name: 'Taken', description: 'd', priority: 0 }));
    const categories = 'catName,catNameShort,catDesc,catPriority\nNew one,taken,d,0\nGood,GOOD,d,5\n';
    const questions = `${header}\nGood,TRUE,,FALSE,Fine?,"Yes, No",Yes,x\nNowhere,TRUE,,FALSE,Lost?,"Yes, No",Yes,x\nGood,TRUE,,FALSE,Wrong?,"Yes, No",Maybe,x\n`;
    const files = [{ name: 'categories', content: categories }, { name: 'questions', content: questions }];
    const preview = (await upload('preview', files)).json();
    assert.deepEqual(preview.problems.map((problem: { field: string; code: string; params: { row: number; column: string } }) => [problem.field, problem.params.row, problem.params.column, problem.code]), [
      ['categories', 2, 'catNameShort', 'duplicate'],
      ['questions', 3, 'category', 'not_allowed'],
      ['questions', 4, 'correctAnswer', 'not_allowed'],
    ]);
    assert.deepEqual(preview.categories, { create: 1, skip: 0 });
    const before = totalChanges(context);
    const refused = await upload('import', files);
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json().error, 'validation_failed');
    assert.equal(refused.json().fields.length, 3);
    assert.equal(totalChanges(context), before);
  });

  it('accepts only CSV text files of at most 1 MiB, and leaves nothing on disk (the SEC-9 deviation)', async () => {
    const before = filesUnder(context.dataDir);
    const oversized = await upload('preview', [{ name: 'questions', content: `${header}\n${'x'.repeat(maxImportFileBytes)}` }]);
    assert.equal(oversized.statusCode, 413);
    assert.deepEqual(oversized.json().params, { maxBytes: maxImportFileBytes });
    const binary = await upload('preview', [{ name: 'questions', content: Buffer.from([0x63, 0x61, 0x00, 0x74]) }]);
    assert.deepEqual(binary.json().fields.map((field: { field: string; code: string }) => [field.field, field.code]), [['questions', 'invalid_format']]);
    const latin1 = await upload('preview', [{ name: 'categories', content: Buffer.from([0x63, 0xe9, 0x0a]) }]);
    assert.deepEqual(latin1.json().fields.map((field: { field: string; code: string }) => [field.field, field.code]), [['categories', 'invalid_format']]);
    const image = await upload('preview', [{ name: 'questions', content: questionsCsv, type: 'image/png' }]);
    assert.deepEqual(image.json().fields.map((field: { field: string; code: string }) => [field.field, field.code]), [['questions', 'not_allowed']]);
    // A BOM, as Excel writes it, is fine.
    const bom = await upload('preview', [{ name: 'categories', content: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), categoriesCsv]), type: 'application/vnd.ms-excel' }]);
    assert.equal(bom.statusCode, 200);
    assert.equal((await upload('preview', [])).json().error, 'file_required');
    assert.equal((await upload('replace', sheet)).json().fields[0].field, 'action');
    const json = await app.inject({ method: 'POST', url: '/api/admin/import', headers: { cookie, ...csrf }, payload: { action: 'preview' } });
    assert.equal(json.statusCode, 415);
    assert.deepEqual(filesUnder(context.dataDir), before);
  });

  it('audits an import with its counts only (LOG-14)', async () => {
    await upload('preview', sheet);
    const entry = context.logs.listAudit({}, null, 50).find((candidate) => candidate.action === 'importSheet' && candidate.outcome === 'success')!;
    assert.deepEqual(entry.details, {
      action: 'preview', files: ['categories', 'questions'],
      categories: { create: 0, skip: 3 }, questions: { create: 0, skip: 11, approved: 0, pending: 0 }, problems: 0,
    });
    assert.doesNotMatch(JSON.stringify(entry), /HTF|Bufalo/);
  });
});
