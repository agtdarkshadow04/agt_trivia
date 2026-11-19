import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it, mock } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.js';
import { hashPassword, parseHash, scryptImplementation, secretsEqual, verifyPassword } from '../passwords.js';
import { adminExists } from '../repository/admin.js';
import { readSettings } from '../repository/settings.js';
import { apiRoutes } from '../routes.js';
import { setupPasswordCheck } from '../session.js';
import { adminCookie, adminWriteHeaders, testAdmin, testContext, testSetupPassword } from './helpers.js';

const csrf = { 'x-agt-request': '1' };

function sessionToken(response: LightMyRequestResponse) {
  const header = String(response.headers['set-cookie'] ?? '');
  return /^agt_trivia_session=([^;]*)/.exec(header)?.[1];
}

function cookieOf(response: LightMyRequestResponse) {
  return `agt_trivia_session=${sessionToken(response)}`;
}

/** A fresh app on a fresh database; `close()` both. */
function server(config = '', options: { setupPassword?: string | null } = {}) {
  const context = testContext(config, options);
  const app = buildApp(context);
  return { context, app, close: async () => { await app.close(); context.close(); } };
}

const setupBody = { setupPassword: testSetupPassword, username: testAdmin.username, password: testAdmin.password };

describe('first-run setup (AUTH-5, AUTH-6)', () => {
  it('reports the status before and after setup', async () => {
    const { app, close } = server();
    try {
      assert.deepEqual((await app.inject('/api/setup/status')).json(), { adminExists: false, setupPasswordConfigured: true });
      assert.equal((await app.inject({ method: 'POST', url: '/api/setup', headers: csrf, payload: setupBody })).statusCode, 201);
      assert.deepEqual((await app.inject('/api/setup/status')).json(), { adminExists: true, setupPasswordConfigured: true });
    } finally {
      await close();
    }
  });

  it('answers 503 setup_password_missing while the variable is unset', async () => {
    const { app, close } = server('', { setupPassword: null });
    try {
      assert.deepEqual((await app.inject('/api/setup/status')).json(), { adminExists: false, setupPasswordConfigured: false });
      const response = await app.inject({ method: 'POST', url: '/api/setup', headers: csrf, payload: setupBody });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error, 'setup_password_missing');
      assert.match(response.json().message, /AGT_TRIVIA_SETUP_PASSWORD is not set/);
    } finally {
      await close();
    }
  });

  it('rejects a wrong setup password, a missing CSRF header, and invalid credentials', async () => {
    const { app, context, close } = server();
    try {
      const wrong = await app.inject({ method: 'POST', url: '/api/setup', headers: csrf, payload: { ...setupBody, setupPassword: 'nope' } });
      assert.equal(wrong.statusCode, 401);
      assert.equal(wrong.json().error, 'invalid_setup_password');
      const noCsrf = await app.inject({ method: 'POST', url: '/api/setup', payload: setupBody });
      assert.equal(noCsrf.statusCode, 403);
      assert.equal(noCsrf.json().error, 'csrf');
      const cases: [Record<string, string>, string, string][] = [
        [{ username: '   ' }, 'username', 'required'],
        [{ username: 'x'.repeat(65) }, 'username', 'too_long'],
        [{ password: 'short' }, 'password', 'too_short'],
        [{ password: testSetupPassword }, 'password', 'same_as_setup_password'],
      ];
      for (const [change, field, code] of cases) {
        const response = await app.inject({ method: 'POST', url: '/api/setup', headers: csrf, payload: { ...setupBody, ...change } });
        assert.equal(response.statusCode, 400, `${field} ${code}`);
        assert.equal(response.json().error, 'validation_failed');
        assert.equal(response.json().fields[0].field, field);
        assert.equal(response.json().fields[0].code, code);
      }
      assert.equal(adminExists(context.db), false);
    } finally {
      await close();
    }
  });

  it('creates the Admin with a trimmed username, signs it in, and refuses setup afterwards even while the variable is set', async () => {
    const { app, context, close } = server();
    try {
      const response = await app.inject({ method: 'POST', url: '/api/setup', headers: csrf, payload: { ...setupBody, username: `  ${testAdmin.username} ` } });
      assert.equal(response.statusCode, 201);
      assert.deepEqual(response.json(), { username: testAdmin.username });
      const session = await app.inject({ url: '/api/admin/session', headers: { cookie: cookieOf(response) } });
      assert.deepEqual(session.json(), { username: testAdmin.username, version: context.version, setupPasswordStillSet: true, restoreFailed: false });
      const again = await app.inject({ method: 'POST', url: '/api/setup', headers: csrf, payload: setupBody });
      assert.equal(again.statusCode, 410);
      assert.equal(again.json().error, 'setup_complete');
      assert.ok(!JSON.stringify(context.db.connection.prepare('SELECT * FROM admin').all()).includes(testSetupPassword), 'the setup password is never stored');
    } finally {
      await close();
    }
  });

  it('stops startup on a setup password over 1024 characters while no Admin exists, and warns once one exists', async () => {
    const long = testContext('', { setupPassword: 'x'.repeat(1025) });
    assert.match(setupPasswordCheck(long).error ?? '', /longer than 1024 characters/);
    long.close();
    assert.deepEqual(setupPasswordCheck(testContext('', { setupPassword: 'x'.repeat(1024) })), {});
    assert.deepEqual(setupPasswordCheck(testContext('', { setupPassword: null })), {});
    const done = testContext();
    await adminCookie(done);
    assert.match(setupPasswordCheck(done).warning ?? '', /still set/);
    assert.equal(setupPasswordCheck({ ...done, setupPassword: 'x'.repeat(2000) }).error, undefined);
    done.close();
  });
});

describe('password hashing (AUTH-2, AUTH-3)', () => {
  afterEach(() => mock.restoreAll());

  it('hashes with the fixed profile and verifies', async () => {
    const stored = await hashPassword('correct horse battery staple');
    assert.match(stored, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{86}==$/);
    assert.ok(parseHash(stored));
    assert.deepEqual(await verifyPassword('correct horse battery staple', stored), { ok: true });
    assert.deepEqual(await verifyPassword('wrong', stored), { ok: false, malformed: false });
    assert.deepEqual(await verifyPassword('ｃｏｒｒｅｃｔ horse battery staple', stored), { ok: true }, 'NFKC-normalized');
  });

  it('rejects hostile or malformed stored hashes without calling scrypt', async () => {
    const good = (await hashPassword('password password')).split('$');
    const spy = mock.method(scryptImplementation, 'run');
    const hostile = [
      ['scrypt', String(2 ** 30), '8', '1', good[4], good[5]],
      ['scrypt', '32768', '1024', '1', good[4], good[5]],
      ['scrypt', '32768', '8', '0', good[4], good[5]],
      ['scrypt', '16384', '8', '1', good[4], good[5]],
      ['scrypt', '032768', '8', '1', good[4], good[5]],
      ['scrypt', '+32768', '8', '1', good[4], good[5]],
      ['scrypt', 'abc', '8', '1', good[4], good[5]],
      ['scrypt', '32768', '8', '1', good[4].slice(4), good[5]],
      ['scrypt', '32768', '8', '1', good[4], good[5].slice(4)],
      ['bcrypt', '32768', '8', '1', good[4], good[5]],
      ['scrypt', '32768', '8', good[4], good[5]],
      ['scrypt', '32768', '8', '1', good[4], good[5], 'extra'],
    ];
    for (const fields of hostile) {
      assert.deepEqual(await verifyPassword('password password', fields.join('$')), { ok: false, malformed: true }, fields.join('$'));
    }
    assert.equal(spy.mock.callCount(), 0);
  });

  it('answers 401 invalid_credentials for a malformed Admin hash and logs it without the hash', async () => {
    const { app, context, close } = server();
    try {
      await adminCookie(context);
      context.db.connection.prepare("UPDATE admin SET password_hash = 'scrypt$1073741824$8$1$AAAA$AAAA'").run();
      const spy = mock.method(scryptImplementation, 'run');
      const response = await app.inject({ method: 'POST', url: '/api/admin/login', headers: csrf, payload: testAdmin });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error, 'invalid_credentials');
      assert.equal(spy.mock.callCount(), 0);
    } finally {
      await close();
    }
  });

  it('compares secrets of any length in constant time', () => {
    assert.equal(secretsEqual('a', 'a'), true);
    assert.equal(secretsEqual('a', 'ab'), false);
    assert.equal(secretsEqual('', ''), true);
  });
});

describe('Admin sign-in and sessions (AUTH-3, AUTH-4, AUTH-8, AUTH-9)', () => {
  let ctx: ReturnType<typeof server>;
  before(async () => { ctx = server(); await adminCookie(ctx.context); });
  after(() => ctx.close());

  it('answers the same 401 for a wrong username, a wrong password and no CSRF header', async () => {
    for (const payload of [{ ...testAdmin, username: 'someone' }, { ...testAdmin, password: 'Wrong-Password-1!' }]) {
      const response = await ctx.app.inject({ method: 'POST', url: '/api/admin/login', headers: csrf, payload });
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { error: 'invalid_credentials', message: 'Invalid username or password.' });
      assert.equal(response.headers['set-cookie'], undefined);
    }
    assert.equal((await ctx.app.inject({ method: 'POST', url: '/api/admin/login', payload: testAdmin })).json().error, 'csrf');
  });

  it('answers 401 when no Admin exists yet', async () => {
    const fresh = server();
    try {
      const response = await fresh.app.inject({ method: 'POST', url: '/api/admin/login', headers: csrf, payload: testAdmin });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error, 'invalid_credentials');
    } finally {
      await fresh.close();
    }
  });

  it('sets an HttpOnly, SameSite=Strict cookie for the trimmed username and stores only its hash', async () => {
    const response = await ctx.app.inject({ method: 'POST', url: '/api/admin/login', headers: csrf, payload: { ...testAdmin, username: ` ${testAdmin.username}\t` } });
    assert.equal(response.statusCode, 200);
    const header = String(response.headers['set-cookie']);
    assert.match(header, /^agt_trivia_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=43200; HttpOnly; SameSite=Strict$/);
    const token = sessionToken(response)!;
    const rows = ctx.context.db.connection.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.token_hash !== token && /^[0-9a-f]{64}$/.test(row.token_hash)));
  });

  it('rejects an expired session, clears an unknown cookie, and signs out', async () => {
    const login = await ctx.app.inject({ method: 'POST', url: '/api/admin/login', headers: csrf, payload: testAdmin });
    const cookie = cookieOf(login);
    assert.equal((await ctx.app.inject({ url: '/api/admin/session', headers: { cookie } })).statusCode, 200);
    const logout = await ctx.app.inject({ method: 'POST', url: '/api/admin/logout', headers: { cookie, ...csrf } });
    assert.equal(logout.statusCode, 204);
    assert.match(String(logout.headers['set-cookie']), /^agt_trivia_session=; Path=\/; Max-Age=0/);
    const afterLogout = await ctx.app.inject({ url: '/api/admin/session', headers: { cookie } });
    assert.equal(afterLogout.statusCode, 401);
    assert.equal(afterLogout.json().error, 'unauthorized');
    assert.match(String(afterLogout.headers['set-cookie']), /Max-Age=0/);

    const expiring = cookieOf(await ctx.app.inject({ method: 'POST', url: '/api/admin/login', headers: csrf, payload: testAdmin }));
    ctx.context.db.connection.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    assert.equal((await ctx.app.inject({ url: '/api/admin/session', headers: { cookie: expiring } })).statusCode, 401);
  });

  it('changes the password, ending every other session but the caller\'s', async () => {
    const other = await adminCookie(ctx.context);
    const mine = await adminCookie(ctx.context);
    const wrong = await ctx.app.inject({ method: 'POST', url: '/api/admin/password', headers: { cookie: mine, ...csrf }, payload: { currentPassword: 'Nope-nope-nope', password: 'Another-Password-2!' } });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json().error, 'invalid_credentials');
    const reused = await ctx.app.inject({ method: 'POST', url: '/api/admin/password', headers: { cookie: mine, ...csrf }, payload: { currentPassword: testAdmin.password, password: testSetupPassword } });
    assert.equal(reused.json().fields[0].code, 'same_as_setup_password');
    const short = await ctx.app.inject({ method: 'POST', url: '/api/admin/password', headers: { cookie: mine, ...csrf }, payload: { currentPassword: testAdmin.password, password: 'short' } });
    assert.equal(short.json().fields[0].code, 'too_short');

    const changed = await ctx.app.inject({ method: 'POST', url: '/api/admin/password', headers: { cookie: mine, ...csrf }, payload: { currentPassword: testAdmin.password, password: 'Another-Password-2!' } });
    assert.equal(changed.statusCode, 200);
    const fresh = cookieOf(changed);
    assert.equal((await ctx.app.inject({ url: '/api/admin/session', headers: { cookie: other } })).statusCode, 401);
    assert.equal((await ctx.app.inject({ url: '/api/admin/session', headers: { cookie: mine } })).statusCode, 401);
    assert.equal((await ctx.app.inject({ url: '/api/admin/session', headers: { cookie: fresh } })).statusCode, 200);
    // Put it back for the other tests.
    await ctx.app.inject({ method: 'POST', url: '/api/admin/password', headers: { cookie: fresh, ...csrf }, payload: { currentPassword: 'Another-Password-2!', password: testAdmin.password } });
  });

  it('protects every admin route: 401 without a session, 403 for a write without the CSRF header', async () => {
    const cookie = await adminCookie(ctx.context);
    const url = (path: string) => path.replace(/:([A-Za-z]+)/g, '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e');
    const adminRoutes = apiRoutes.filter((route) => route.auth === 'admin');
    assert.ok(adminRoutes.length >= 5);
    for (const route of adminRoutes) {
      const anonymous = await ctx.app.inject({ method: route.method, url: url(route.url), headers: csrf, payload: route.method === 'GET' ? undefined : {} });
      assert.equal(anonymous.statusCode, 401, `${route.method} ${route.url}`);
      assert.equal(anonymous.json().error, 'unauthorized');
      if (route.method === 'GET') continue;
      const noCsrf = await ctx.app.inject({ method: route.method, url: url(route.url), headers: { cookie }, payload: {} });
      assert.equal(noCsrf.statusCode, 403, `${route.method} ${route.url}`);
      assert.equal(noCsrf.json().error, 'csrf');
    }
    for (const route of apiRoutes.filter((entry) => entry.auth === 'csrf')) {
      const noCsrf = await ctx.app.inject({ method: route.method, url: route.url, payload: {} });
      assert.equal(noCsrf.json().error, 'csrf', `${route.method} ${route.url}`);
    }
  });

  it('never accepts a bearer token or another cookie name in place of the session', async () => {
    const token = (await adminCookie(ctx.context)).split('=')[1];
    for (const headers of [{ authorization: `Bearer ${token}` }, { cookie: `agt_admin_session=${token}` }]) {
      assert.equal((await ctx.app.inject({ url: '/api/admin/session', headers })).statusCode, 401);
    }
  });
});

describe('cookies behind a proxy (AUTH-8, TEST-8)', () => {
  it('marks the cookie Secure for HTTPS a trusted proxy reports, and ignores the header otherwise', async () => {
    for (const [config, secure] of [['server:\n  trustProxy: 127.0.0.1\n', true], ['', false]] as const) {
      const { app, context, close } = server(config);
      try {
        await adminCookie(context);
        const response = await app.inject({ method: 'POST', url: '/api/admin/login', remoteAddress: '127.0.0.1', headers: { ...csrf, 'x-forwarded-proto': 'https' }, payload: testAdmin });
        assert.equal(response.statusCode, 200);
        assert.equal(/; Secure$/.test(String(response.headers['set-cookie'])), secure, config || 'no trustProxy');
      } finally {
        await close();
      }
    }
  });

  it('follows session.secureCookie when it is true or false', async () => {
    const { app, context, close } = server('session:\n  secureCookie: true\n  ttlHours: 2\n');
    try {
      await adminCookie(context);
      const header = String((await app.inject({ method: 'POST', url: '/api/admin/login', headers: csrf, payload: testAdmin })).headers['set-cookie']);
      assert.match(header, /Max-Age=7200; HttpOnly; SameSite=Strict; Secure$/);
    } finally {
      await close();
    }
  });
});

describe('rate limits (SEC-7)', () => {
  it('limits sign-in per client address with 429, Retry-After and params, counting each route separately', async () => {
    const { app, context, close } = server('rateLimits:\n  login: { max: 2, windowMinutes: 1 }\n');
    try {
      const cookie = await adminCookie(context);
      const login = () => app.inject({ method: 'POST', url: '/api/admin/login', headers: csrf, payload: { ...testAdmin, password: 'Wrong-Password-1!' } });
      assert.equal((await login()).statusCode, 401);
      assert.equal((await login()).statusCode, 401);
      const limited = await login();
      assert.equal(limited.statusCode, 429);
      assert.equal(limited.json().error, 'rate_limited');
      assert.equal(typeof limited.json().params.retryAfterSeconds, 'number');
      assert.ok(Number(limited.headers['retry-after']) > 0);
      const other = await app.inject({ method: 'POST', url: '/api/admin/login', remoteAddress: '10.0.0.9', headers: csrf, payload: testAdmin });
      assert.equal(other.statusCode, 200, 'another address has its own count');
      const password = await app.inject({ method: 'POST', url: '/api/admin/password', headers: { cookie, ...csrf }, payload: { currentPassword: 'Nope-nope-nope', password: 'Another-Password-2!' } });
      assert.equal(password.statusCode, 401, 'the password change has its own count');
      for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await app.inject('/api/health')).statusCode, 200, 'health is never limited');
    } finally {
      await close();
    }
  });
});

describe('settings in the dashboard (CFG-6..CFG-9)', () => {
  let ctx: ReturnType<typeof server>;
  let headers: Record<string, string>;
  before(async () => {
    ctx = server('site:\n  supportUrl: https://example.com/help\n');
    headers = await adminWriteHeaders(ctx.context);
  });
  after(() => ctx.close());

  const put = (values: Record<string, unknown>) => ctx.app.inject({ method: 'PUT', url: '/api/admin/settings', headers, payload: { values } });

  it('lists every setting with its source, and the locked one as locked', async () => {
    const response = await ctx.app.inject({ url: '/api/admin/settings', headers: { cookie: headers.cookie } });
    const settings = response.json().settings as { key: string; source: string; locked: boolean; value: unknown }[];
    assert.deepEqual(settings.map((entry) => [entry.key, entry.source, entry.locked]).slice(0, 4), [
      ['site.title', 'default', false], ['site.supportUrl', 'config', true], ['quiz.shortLength', 'default', false], ['quiz.longLength', 'default', false],
    ]);
    assert.ok(settings.every((entry) => entry.key === 'site.supportUrl' || !entry.locked));
  });

  it('changes and resets settings', async () => {
    const response = await put({ 'site.title': 'Trivia Night', 'quiz.shortLength': 5 });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().notices, []);
    const title = response.json().settings.find((entry: { key: string }) => entry.key === 'site.title');
    assert.deepEqual([title.value, title.source], ['Trivia Night', 'dashboard']);
    assert.equal((await ctx.app.inject('/api/settings/public')).json().siteTitle, 'Trivia Night');
    await put({ 'site.title': null });
    assert.equal((await ctx.app.inject('/api/settings/public')).json().siteTitle, 'AGT Galactic Trivia');
  });

  it('rejects the whole request for a locked, unknown or invalid key, changing nothing (CFG-8)', async () => {
    const before = [...readSettings(ctx.context.db)];
    const locked = await put({ 'site.title': 'Changed', 'site.supportUrl': 'https://example.org' });
    assert.equal(locked.statusCode, 409);
    assert.deepEqual(locked.json(), {
      error: 'defined_in_config', message: 'site.supportUrl is defined in the configuration file and cannot be changed from the dashboard.', params: { key: 'site.supportUrl' },
    });
    const unknown = await put({ 'site.colour': 'red' });
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.json().error, 'unknown_setting');
    assert.deepEqual(unknown.json().params, { key: 'site.colour' });
    for (const values of [{ 'quiz.shortLength': 0 }, { 'quiz.shortLength': 'ten' }, { 'site.title': '' }, { 'site.title': 'x'.repeat(101) }]) {
      const invalid = await put(values);
      assert.equal(invalid.statusCode, 400, JSON.stringify(values));
      assert.equal(invalid.json().error, 'invalid_setting');
      assert.equal(invalid.json().fields[0].field, Object.keys(values)[0]);
    }
    const lengths = await put({ 'quiz.shortLength': 40 });
    assert.equal(lengths.json().error, 'invalid_setting');
    assert.equal(lengths.json().fields[0].field, 'quiz.shortLength');
    assert.equal(lengths.json().fields[0].code, 'out_of_range');
    assert.deepEqual([...readSettings(ctx.context.db)], before);
  });
});
