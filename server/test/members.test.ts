import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.js';
import { withDataWrite } from '../dataWrite.js';
import { LOG_MIGRATIONS } from '../logs.js';
import { openSqlite, runMigrations } from '../db.js';
import { insertQuestion } from '../repository/questions.js';
import { adminCookie, createMember, memberCookie, sampleQuestion, seedQuiz, testContext, testMemberPassword, type TestContextOptions } from './helpers.js';

/** Member accounts (#17, the AUTH-1 deviation): sign-in, session separation, roles and the Admin's Members tab. */

const csrf = { 'x-agt-request': '1' };

function server(config = '', options: TestContextOptions = {}) {
  const context = testContext(config, options);
  const app = buildApp(context);
  return { context, app, close: async () => { await app.close(); context.close(); } };
}

function memberToken(response: LightMyRequestResponse) {
  return /^agt_trivia_member_session=([^;]*)/.exec(String(response.headers['set-cookie'] ?? ''))?.[1];
}

const memberLogin = (app: ReturnType<typeof server>['app'], username: string, password = testMemberPassword, headers: Record<string, string> = csrf) => (
  app.inject({ method: 'POST', url: '/api/member/login', headers, payload: { username, password } })
);

describe('the members table', () => {
  it('stores lowercase usernames of letters, digits, dots, underscores and hyphens, unique, and local members with a password', () => {
    const context = testContext();
    try {
      const insert = (username: string | null, source = 'local', hash: string | null = 'hash') => context.db.connection.prepare(`INSERT INTO members
        (id, auth_source, username, display_name, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, 'D', ?, 'Player', 1, 'x', 'x')`)
        .run(randomUUID(), source, username, hash);
      insert('ok.name_1-a');
      assert.throws(() => insert('ok.name_1-a'), /UNIQUE/);
      assert.throws(() => insert('Upper'), /CHECK/);
      assert.throws(() => insert('ab'), /CHECK/);
      assert.throws(() => insert('has space'), /CHECK/);
      assert.throws(() => insert(null), /CHECK/);
      assert.throws(() => insert('nohash', 'local', null), /CHECK/);
      assert.throws(() => insert('bad-source', 'other'), /CHECK/);
      // An AGT member (#18) has neither a username nor a password.
      insert(null, 'agt_iam', null);
    } finally {
      context.close();
    }
  });
});

describe('member sign-in (AUTH-3, AUTH-8)', () => {
  it('signs a member in by username, ignoring case, with a member session cookie', async () => {
    const { app, context, close } = server();
    try {
      await createMember(context, 'pilot', 'Editor');
      const response = await memberLogin(app, '  PILOT ');
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(Object.keys(response.json()).sort(), ['authSource', 'displayName', 'id', 'role', 'username']);
      assert.equal(response.json().role, 'Editor');
      const cookie = String(response.headers['set-cookie']);
      assert.match(cookie, /^agt_trivia_member_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Strict$/);
      const session = await app.inject({ url: '/api/member/session', headers: { cookie: `agt_trivia_member_session=${memberToken(response)}` } });
      assert.equal(session.statusCode, 200);
      assert.equal(session.json().username, 'pilot');
      // The token is stored only as its SHA-256 (AUTH-8).
      const stored = context.db.connection.prepare('SELECT token_hash FROM member_sessions').all() as { token_hash: string }[];
      assert.equal(stored.length, 1);
      assert.notEqual(stored[0].token_hash, memberToken(response));
    } finally {
      await close();
    }
  });

  it('refuses a wrong password, an unknown member and an inactive one alike', async () => {
    const { app, context, close } = server();
    try {
      const member = await createMember(context, 'pilot');
      for (const [username, password] of [['pilot', 'Wrong-Password-1!'], ['nobody', testMemberPassword]]) {
        const response = await memberLogin(app, username, password);
        assert.equal(response.statusCode, 401);
        assert.equal(response.json().error, 'invalid_credentials');
      }
      const admin = await adminCookie(context);
      await app.inject({ method: 'PUT', url: `/api/admin/members/${member.id}`, headers: { cookie: admin, ...csrf }, payload: { displayName: 'Pilot', role: 'Player', isActive: false } });
      assert.equal((await memberLogin(app, 'pilot')).json().error, 'invalid_credentials');
    } finally {
      await close();
    }
  });

  it('signs out, ending the session and clearing the cookie', async () => {
    const { app, context, close } = server();
    try {
      await createMember(context, 'pilot');
      const cookie = await memberCookie(context, 'pilot');
      const logout = await app.inject({ method: 'POST', url: '/api/member/logout', headers: { cookie, ...csrf } });
      assert.equal(logout.statusCode, 204);
      assert.match(String(logout.headers['set-cookie']), /^agt_trivia_member_session=; Path=\/; Max-Age=0/);
      assert.equal((await app.inject({ url: '/api/member/session', headers: { cookie } })).statusCode, 401);
    } finally {
      await close();
    }
  });

  it('rate limits member sign-in with its own counter (SEC-7)', async () => {
    const { app, context, close } = server('rateLimits:\n  login: { max: 2, windowMinutes: 1 }\n');
    try {
      await createMember(context, 'pilot');
      assert.equal((await memberLogin(app, 'pilot', 'Wrong-Password-1!')).statusCode, 401);
      assert.equal((await memberLogin(app, 'pilot', 'Wrong-Password-1!')).statusCode, 401);
      assert.equal((await memberLogin(app, 'pilot')).statusCode, 429);
      // The Admin's sign-in counts separately.
      const admin = await app.inject({ method: 'POST', url: '/api/admin/login', headers: csrf, payload: { username: 'x', password: 'y' } });
      assert.equal(admin.statusCode, 401);
    } finally {
      await close();
    }
  });
});

describe('session separation (AUTH-1 deviation, AUTH-9, SEC-5)', () => {
  it('never takes one cookie for the other', async () => {
    const { app, context, close } = server();
    try {
      await createMember(context, 'pilot');
      const member = await memberCookie(context, 'pilot');
      const admin = await adminCookie(context);
      const adminWithMember = await app.inject({ url: '/api/admin/members', headers: { cookie: member } });
      assert.equal(adminWithMember.statusCode, 401);
      const memberWithAdmin = await app.inject({ url: '/api/member/session', headers: { cookie: admin } });
      assert.equal(memberWithAdmin.statusCode, 401);
      // A cookie with the other's name and value is still the wrong cookie.
      const swapped = await app.inject({ url: '/api/member/session', headers: { cookie: admin.replace('agt_trivia_session', 'agt_trivia_member_session') } });
      assert.equal(swapped.statusCode, 401);
      assert.match(String(swapped.headers['set-cookie']), /^agt_trivia_member_session=;/);
      // Both at once: each route reads only its own.
      assert.equal((await app.inject({ url: '/api/member/session', headers: { cookie: `${admin}; ${member}` } })).statusCode, 200);
      assert.equal((await app.inject({ url: '/api/admin/session', headers: { cookie: `${admin}; ${member}` } })).json().username, 'keeper');
    } finally {
      await close();
    }
  });

  it('needs the CSRF header on member writes, sign-in included', async () => {
    const { app, context, close } = server();
    try {
      await createMember(context, 'pilot');
      const cookie = await memberCookie(context, 'pilot');
      assert.equal((await memberLogin(app, 'pilot', testMemberPassword, {})).json().error, 'csrf');
      for (const [url, payload] of [['/api/member/logout', undefined], ['/api/member/password', { currentPassword: testMemberPassword, password: 'Another-Password-2!' }]] as const) {
        const response = await app.inject({ method: 'POST', url, headers: { cookie }, payload });
        assert.equal(response.statusCode, 403, url);
        assert.equal(response.json().error, 'csrf');
      }
      assert.equal((await app.inject({ url: '/api/member/session', headers: { cookie } })).statusCode, 200);
    } finally {
      await close();
    }
  });

  it('audits member sign-ins and refusals with the member as the actor (LOG-10, LOG-11)', async () => {
    const { app, context, close } = server();
    try {
      await createMember(context, 'pilot');
      await memberLogin(app, 'pilot');
      await app.inject({ url: '/api/member/session' });
      const entries = context.logs.listAudit({}, null, 50);
      const login = entries.find((entry) => entry.action === 'createMemberSession');
      assert.equal(login?.actorType, 'member');
      assert.equal(login?.actor, 'pilot');
      const denied = entries.find((entry) => entry.action === 'getMemberSession');
      assert.equal(denied?.outcome, 'denied');
      assert.doesNotMatch(JSON.stringify(entries), new RegExp(testMemberPassword));
    } finally {
      await close();
    }
  });
});

describe('the member password change (AUTH-4)', () => {
  it('needs the current password, ends every other session and starts a new one', async () => {
    const { app, context, close } = server();
    try {
      await createMember(context, 'pilot');
      const other = await memberCookie(context, 'pilot');
      const cookie = await memberCookie(context, 'pilot');
      const change = (currentPassword: string, password: string) => app.inject({ method: 'POST', url: '/api/member/password', headers: { cookie, ...csrf }, payload: { currentPassword, password } });
      assert.equal((await change('Wrong-Password-1!', 'Another-Password-2!')).json().error, 'invalid_credentials');
      const short = await change(testMemberPassword, 'short');
      assert.equal(short.statusCode, 400);
      assert.equal(short.json().fields[0].code, 'too_short');
      const changed = await change(testMemberPassword, 'Another-Password-2!');
      assert.equal(changed.statusCode, 200);
      assert.equal((await app.inject({ url: '/api/member/session', headers: { cookie: other } })).statusCode, 401);
      assert.equal((await app.inject({ url: '/api/member/session', headers: { cookie } })).statusCode, 401);
      assert.equal((await app.inject({ url: '/api/member/session', headers: { cookie: `agt_trivia_member_session=${memberToken(changed)}` } })).statusCode, 200);
      assert.equal((await memberLogin(app, 'pilot', 'Another-Password-2!')).statusCode, 200);
      assert.equal((await memberLogin(app, 'pilot')).statusCode, 401);
    } finally {
      await close();
    }
  });
});

describe("the Admin's Members tab (#17)", () => {
  it('creates members with validated, normalized input and no duplicate usernames', async () => {
    const { app, context, close } = server();
    try {
      const cookie = await adminCookie(context);
      const create = (payload: object) => app.inject({ method: 'POST', url: '/api/admin/members', headers: { cookie, ...csrf }, payload });
      const created = await create({ username: ' New.Pilot ', displayName: '  Pilot One ', role: 'Moderator', password: testMemberPassword });
      assert.equal(created.statusCode, 201, created.body);
      assert.deepEqual(created.json().notices, []);
      assert.equal(created.json().member.username, 'new.pilot');
      assert.equal(created.json().member.displayName, 'Pilot One');
      assert.equal(created.json().member.isActive, true);
      assert.equal(created.json().member.authSource, 'local');
      assert.equal('passwordHash' in created.json().member, false);
      const duplicate = await create({ username: 'NEW.PILOT', displayName: 'X', role: 'Player', password: testMemberPassword });
      assert.equal(duplicate.statusCode, 400);
      assert.deepEqual(duplicate.json().fields.map((field: { field: string; code: string }) => [field.field, field.code]), [['username', 'duplicate']]);
      const invalid = await create({ username: 'no spaces', displayName: ' ', role: 'Player', password: 'short' });
      assert.deepEqual(invalid.json().fields.map((field: { field: string; code: string }) => [field.field, field.code]), [
        ['username', 'invalid_format'], ['displayName', 'required'], ['password', 'too_short'],
      ]);
      assert.equal((await create({ username: 'x1x', displayName: 'X', role: 'Admin', password: testMemberPassword })).statusCode, 400);
    } finally {
      await close();
    }
  });

  it('lists members newest first, a page at a time, with a search', async () => {
    const { app, context, close } = server();
    try {
      const cookie = await adminCookie(context);
      for (const name of ['alpha', 'bravo', 'charlie', 'delta', 'echo']) await createMember(context, name);
      const page = async (query: string) => (await app.inject({ url: `/api/admin/members${query}`, headers: { cookie } })).json();
      const first = await page('?limit=2');
      assert.deepEqual(first.items.map((member: { username: string }) => member.username), ['echo', 'delta']);
      const second = await page(`?limit=2&cursor=${first.nextCursor}`);
      assert.deepEqual(second.items.map((member: { username: string }) => member.username), ['charlie', 'bravo']);
      const third = await page(`?limit=2&cursor=${second.nextCursor}`);
      assert.deepEqual(third.items.map((member: { username: string }) => member.username), ['alpha']);
      assert.equal(third.nextCursor, null);
      assert.deepEqual((await page('?q=HAR')).items.map((member: { username: string }) => member.username), ['charlie']);
      assert.deepEqual((await page('?q=%25')).items, []);
      for (const query of ['?limit=201', '?limit=0', '?cursor=bogus']) {
        assert.equal((await app.inject({ url: `/api/admin/members${query}`, headers: { cookie } })).statusCode, 400, query);
      }
    } finally {
      await close();
    }
  });

  it('ends a member\'s sessions on a role change, a deactivation, a password reset and a deletion, not on a rename (AUTH-4)', async () => {
    const { app, context, close } = server();
    try {
      const admin = await adminCookie(context);
      const member = await createMember(context, 'pilot', 'Editor');
      const replace = (body: object) => app.inject({ method: 'PUT', url: `/api/admin/members/${member.id}`, headers: { cookie: admin, ...csrf }, payload: body });

      let cookie = await memberCookie(context, 'pilot');
      const renamed = await replace({ displayName: 'Captain', role: 'Editor', isActive: true });
      assert.equal(renamed.json().member.displayName, 'Captain');
      assert.equal((await app.inject({ url: '/api/member/session', headers: { cookie } })).statusCode, 200, 'a rename keeps the session');

      const promoted = await replace({ displayName: 'Captain', role: 'Moderator', isActive: true });
      assert.equal(promoted.json().member.role, 'Moderator');
      assert.equal((await app.inject({ url: '/api/member/session', headers: { cookie } })).statusCode, 401, 'a role change ends it');
      const audit = context.logs.listAudit({}, null, 50).find((entry) => entry.action === 'replaceMember' && (entry.details as { changed: string[] }).changed.includes('role'));
      assert.deepEqual(audit?.details, { username: 'pilot', changed: ['role'], role: 'Moderator' });

      cookie = await memberCookie(context, 'pilot');
      await replace({ displayName: 'Captain', role: 'Moderator', isActive: false });
      assert.equal((await app.inject({ url: '/api/member/session', headers: { cookie } })).statusCode, 401, 'a deactivation ends it');
      await replace({ displayName: 'Captain', role: 'Moderator', isActive: true });

      cookie = await memberCookie(context, 'pilot');
      const reset = await app.inject({ method: 'POST', url: `/api/admin/members/${member.id}/password`, headers: { cookie: admin, ...csrf }, payload: { password: 'Reset-Password-3!' } });
      assert.equal(reset.statusCode, 200, reset.body);
      assert.equal((await app.inject({ url: '/api/member/session', headers: { cookie } })).statusCode, 401, 'a password reset ends it');
      assert.equal((await memberLogin(app, 'pilot', 'Reset-Password-3!')).statusCode, 200);

      cookie = `agt_trivia_member_session=${memberToken(await memberLogin(app, 'pilot', 'Reset-Password-3!'))}`;
      const deleted = await app.inject({ method: 'DELETE', url: `/api/admin/members/${member.id}`, headers: { cookie: admin, ...csrf } });
      assert.equal(deleted.statusCode, 204);
      assert.equal((await app.inject({ url: '/api/member/session', headers: { cookie } })).statusCode, 401, 'a deletion ends it');
      assert.equal((context.db.connection.prepare('SELECT count(*) AS n FROM member_sessions').get() as { n: number }).n, 0);
    } finally {
      await close();
    }
  });

  it('keeps a deleted member\'s questions without their ID', async () => {
    const { app, context, close } = server();
    try {
      const admin = await adminCookie(context);
      const member = await createMember(context, 'author', 'Editor');
      const { category } = await seedQuiz(context, 0);
      const question = await withDataWrite(context.operations, () => insertQuestion(context.db, sampleQuestion(category.id, 'Mine?', { createdBy: member.id, approvedBy: member.id })));
      await app.inject({ method: 'DELETE', url: `/api/admin/members/${member.id}`, headers: { cookie: admin, ...csrf } });
      const row = context.db.connection.prepare('SELECT created_by, approved_by, modified_by, prompt FROM questions WHERE id = ?').get(question.id);
      assert.deepEqual({ ...row as object }, { created_by: null, approved_by: null, modified_by: null, prompt: 'Mine?' });
    } finally {
      await close();
    }
  });

  it('answers 404 for an unknown or malformed member, and needs the Admin', async () => {
    const { app, context, close } = server();
    try {
      const admin = await adminCookie(context);
      for (const id of [randomUUID(), 'nope']) {
        const response = await app.inject({ method: 'DELETE', url: `/api/admin/members/${id}`, headers: { cookie: admin, ...csrf } });
        assert.equal(response.statusCode, 404, id);
      }
      await createMember(context, 'pilot', 'Moderator');
      const member = await memberCookie(context, 'pilot');
      for (const [method, url] of [['GET', '/api/admin/members'], ['POST', '/api/admin/members']] as const) {
        const response = await app.inject({ method, url, headers: { cookie: member, ...csrf }, payload: method === 'POST' ? {} : undefined });
        assert.equal(response.statusCode, 401, `${method} ${url}: a Moderator is not the Admin`);
      }
    } finally {
      await close();
    }
  });

  it('does not set a password for an AGT member', async () => {
    const { app, context, close } = server();
    try {
      const admin = await adminCookie(context);
      const id = randomUUID();
      context.db.connection.prepare(`INSERT INTO members (id, auth_source, username, display_name, password_hash, role, is_active, created_at, updated_at)
        VALUES (?, 'agt_iam', NULL, 'Traveller', NULL, 'Player', 1, 'x', 'x')`).run(id);
      const response = await app.inject({ method: 'POST', url: `/api/admin/members/${id}/password`, headers: { cookie: admin, ...csrf }, payload: { password: 'Reset-Password-3!' } });
      assert.equal(response.statusCode, 409);
    } finally {
      await close();
    }
  });
});

describe('the last sign-in on the Members tab (#48)', () => {
  it('records each successful sign-in, never a failed one, without changing updatedAt', async () => {
    const { app, context, close } = server();
    try {
      const cookie = await adminCookie(context);
      const created = await createMember(context, 'last.seen');
      assert.equal(created.lastSignInAt, null);
      const read = async () => (await app.inject({ url: '/api/admin/members?q=last.seen', headers: { cookie } })).json().items[0] as { lastSignInAt: string | null; updatedAt: string };
      assert.equal((await memberLogin(app, 'last.seen', 'wrong-password-123')).statusCode, 401);
      assert.equal((await read()).lastSignInAt, null, 'a failed sign-in records nothing');
      const before = Date.now();
      assert.equal((await memberLogin(app, 'LAST.SEEN')).statusCode, 200);
      const first = await read();
      assert.ok(first.lastSignInAt && Date.parse(first.lastSignInAt) >= before - 1000);
      assert.equal(first.updatedAt, created.updatedAt, 'the account itself did not change');
      await new Promise((resolve) => setTimeout(resolve, 5));
      await memberLogin(app, 'last.seen');
      assert.ok(Date.parse((await read()).lastSignInAt!) > Date.parse(first.lastSignInAt));
      // An inactive member's refused sign-in records nothing either.
      const id = created.id;
      await app.inject({ method: 'PUT', url: `/api/admin/members/${id}`, headers: { cookie, ...csrf }, payload: { displayName: created.displayName, role: 'Player', isActive: false } });
      const stamp = (await read()).lastSignInAt;
      assert.equal((await memberLogin(app, 'last.seen')).statusCode, 401);
      assert.equal((await read()).lastSignInAt, stamp);
    } finally {
      await close();
    }
  });

  it('refuses a member sign-in during a restore, as every data write (BAK-8)', async () => {
    const { app, context, close } = server();
    try {
      await createMember(context, 'in.restore');
      await context.operations.begin('restore');
      const response = await memberLogin(app, 'in.restore');
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error, 'maintenance');
      context.operations.end('idle');
      assert.equal((await memberLogin(app, 'in.restore')).statusCode, 200);
    } finally {
      await close();
    }
  });

  it('lists the members who never signed in or not for idleDays', async () => {
    const { app, context, close } = server();
    try {
      const cookie = await adminCookie(context);
      for (const name of ['idle.never', 'idle.recent', 'idle.old']) await createMember(context, name);
      await memberLogin(app, 'idle.recent');
      await memberLogin(app, 'idle.old');
      const longAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
      context.db.connection.prepare("UPDATE members SET last_sign_in_at = ? WHERE username = 'idle.old'").run(longAgo);
      const names = async (query: string) => ((await app.inject({ url: `/api/admin/members?q=idle.${query}`, headers: { cookie } })).json().items as { username: string }[])
        .map((member) => member.username).sort();
      assert.deepEqual(await names(''), ['idle.never', 'idle.old', 'idle.recent']);
      assert.deepEqual(await names('&idleDays=30'), ['idle.never', 'idle.old']);
      assert.deepEqual(await names('&idleDays=365'), ['idle.never']);
      for (const query of ['?idleDays=0', '?idleDays=3651', '?idleDays=abc', '?idleDays=-1']) {
        assert.equal((await app.inject({ url: `/api/admin/members${query}`, headers: { cookie } })).statusCode, 400, query);
      }
    } finally {
      await close();
    }
  });
});

describe('member sessions in backups (BAK-2, BAK-4)', () => {
  it('backs members up without their sessions, and a restore signs them out', async () => {
    const { app, context, close } = server('', { file: true });
    try {
      await createMember(context, 'pilot');
      const member = await memberCookie(context, 'pilot');
      const admin = await adminCookie(context);
      const backup = await app.inject({ url: '/api/admin/backup', headers: { cookie: admin } });
      const boundary = 'members-boundary';
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="action"\r\n\r\nrestore\r\n--${boundary}\r\nContent-Disposition: form-data; name="backup"; filename="b.zip"\r\n\r\n`),
        backup.rawPayload,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const restored = await app.inject({ method: 'POST', url: '/api/admin/restore', payload, headers: { cookie: admin, ...csrf, 'content-type': `multipart/form-data; boundary=${boundary}` } });
      assert.equal(restored.statusCode, 200, restored.body);
      assert.equal(restored.json().counts.members, 1);
      assert.equal((await app.inject({ url: '/api/member/session', headers: { cookie: member } })).statusCode, 401);
      assert.equal((await memberLogin(app, 'pilot')).statusCode, 200, 'the member is restored');
    } finally {
      await close();
    }
  });
});

describe('the log store migration for member actors (LOG-1, LOG-10)', () => {
  it('keeps every entry and its seq, and allows the member actor', () => {
    const sqlite = openSqlite(':memory:');
    try {
      runMigrations(sqlite, LOG_MIGRATIONS.slice(0, 1));
      sqlite.prepare(`INSERT INTO audit_log (id, at, last_at, actor_type, client, action, method, route, outcome, status_code)
        VALUES ('a', 'x', 'x', 'admin', 'web', 'login', 'POST', '/api/admin/login', 'success', 200)`).run();
      runMigrations(sqlite, LOG_MIGRATIONS);
      assert.deepEqual({ ...sqlite.prepare('SELECT seq, id, actor_type FROM audit_log').get() as object }, { seq: 1, id: 'a', actor_type: 'admin' });
      sqlite.prepare(`INSERT INTO audit_log (id, at, last_at, actor_type, client, action, method, route, outcome, status_code)
        VALUES ('b', 'x', 'x', 'member', 'web', 'login', 'POST', '/api/member/login', 'success', 200)`).run();
      assert.equal((sqlite.prepare("SELECT seq FROM audit_log WHERE id = 'b'").get() as { seq: number }).seq, 2);
    } finally {
      sqlite.close();
    }
  });
});
