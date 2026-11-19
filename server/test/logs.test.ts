import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { buildApp } from '../app.js';
import { parseConfig, validSetting } from '../config.js';
import { createLogger, csvCell, decodeLogCursor, encodeLogCursor, logStoreStream, normalizeAddress, openLogStore, serverEntryFromRecord, startRetention } from '../logs.js';
import { apiRoutes } from '../routes.js';
import { adminCookie, adminWriteHeaders, testAdmin, testContext, testSetupPassword } from './helpers.js';

const csrf = { 'x-agt-request': '1' };

/** A context whose app logs through the real logger into its own log store (LOG-5). */
function loggedServer(config = '', options: Parameters<typeof testContext>[1] = {}) {
  const context = testContext(config, options);
  const stdout = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const logger = createLogger(parseConfig('server:\n  logLevel: debug\n'), stdout, logStoreStream(context.logs));
  const app = buildApp(context, { logger });
  return { context, app, logger, close: async () => { await app.close(); context.close(); } };
}

const audits = (context: ReturnType<typeof testContext>) => context.logs.listAudit({}, null, 1000);
const serverEntries = (context: ReturnType<typeof testContext>) => context.logs.listServer({}, null, 1000);

describe('the audit log (LOG-10, LOG-11)', () => {
  it('audits every non-GET route and every audited GET route, with the right outcome', async () => {
    const { app, context, close } = loggedServer();
    try {
      const headers = await adminWriteHeaders(context);
      const routes = apiRoutes.filter((route) => route.method !== 'GET' || route.audit);
      assert.ok(routes.length >= 8);
      for (const route of routes) {
        const before = audits(context).length;
        const query = route.url.endsWith('/export') ? '?format=csv' : '';
        const payload = route.url === '/api/admin/settings' ? { values: {} } : route.method === 'GET' ? undefined : {};
        const response = await app.inject({ method: route.method, url: `${route.url}${query}`, headers, payload });
        const entries = audits(context);
        assert.equal(entries.length, before + 1, `${route.method} ${route.url} (${response.statusCode}) is audited`);
        const [entry] = entries;
        assert.equal(entry.action, route.operationId);
        assert.equal(entry.method, route.method);
        assert.equal(entry.route, route.url);
        assert.equal(entry.statusCode, response.statusCode);
        assert.equal(entry.outcome, response.statusCode < 400 ? 'success' : response.statusCode === 401 || response.statusCode === 403 ? 'denied' : response.statusCode === 429 ? 'rate_limited' : 'failure');
        assert.equal(entry.requestId, response.headers['x-request-id'] ?? entry.requestId);
      }
    } finally {
      await close();
    }
  });

  it('records success, validation failure, denied and rate-limited outcomes with their actor and client', async () => {
    const { app, context, close } = loggedServer('rateLimits:\n  login: { max: 1, windowMinutes: 1 }\n');
    try {
      const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: { ...csrf, 'x-agt-client': 'web' }, payload: { setupPassword: testSetupPassword, ...testAdmin } });
      assert.equal(setup.statusCode, 201);
      let [entry] = audits(context);
      assert.deepEqual([entry.action, entry.outcome, entry.actorType, entry.actor, entry.client], ['createAdmin', 'success', 'admin', testAdmin.username, 'web']);

      const cookie = (await adminWriteHeaders(context)).cookie;
      await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie, ...csrf }, payload: { values: { 'quiz.shortLength': 0 } } });
      [entry] = audits(context);
      assert.deepEqual([entry.action, entry.outcome, entry.statusCode, entry.actor], ['updateSettings', 'failure', 400, testAdmin.username]);
      assert.deepEqual(entry.details, { error: 'invalid_setting', fields: ['quiz.shortLength'] });

      await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie, ...csrf }, payload: { values: { 'quiz.shortLength': 7 } } });
      [entry] = audits(context);
      assert.deepEqual(entry.details, { changes: [{ key: 'quiz.shortLength', from: 10, to: 7 }] }, 'settings changes carry old and new values (LOG-14)');

      await app.inject('/api/admin/settings');
      [entry] = audits(context);
      assert.deepEqual([entry.action, entry.outcome, entry.statusCode, entry.actorType, entry.actor], ['listSettings', 'denied', 401, 'anonymous', null]);

      await app.inject({ method: 'POST', url: '/api/admin/login', headers: csrf, payload: testAdmin });
      await app.inject({ method: 'POST', url: '/api/admin/login', headers: csrf, payload: testAdmin });
      [entry] = audits(context);
      assert.deepEqual([entry.action, entry.outcome, entry.statusCode], ['createAdminSession', 'rate_limited', 429]);

      const before = audits(context).length;
      await app.inject('/api/health');
      await app.inject('/api/settings/public');
      await app.inject('/api/admin/nothing-here');
      assert.equal(audits(context).length, before, 'ordinary reads and unknown routes are not audited');
    } finally {
      await close();
    }
  });

  it('coalesces repeated failures from one address within 60 seconds, and keeps successes apart', async () => {
    let now = new Date('2026-11-19T10:00:00.000Z');
    const { app, context, close } = loggedServer('', { now: () => now });
    try {
      await adminCookie(context);
      const wrong = (remoteAddress = '203.0.113.7') => app.inject({ method: 'POST', url: '/api/admin/login', remoteAddress, headers: csrf, payload: { ...testAdmin, password: 'Wrong-Password-1!' } });
      for (let attempt = 0; attempt < 3; attempt += 1) await wrong();
      let failures = audits(context).filter((entry) => entry.action === 'createAdminSession');
      assert.equal(failures.length, 1);
      assert.equal(failures[0].count, 3);
      await wrong('198.51.100.2');
      assert.equal(audits(context).filter((entry) => entry.action === 'createAdminSession').length, 2, 'another address is another entry');
      now = new Date(now.getTime() + 61_000);
      await wrong();
      failures = audits(context).filter((entry) => entry.action === 'createAdminSession');
      assert.equal(failures.length, 3, 'after 60 seconds a new entry starts');
      assert.equal(failures.find((entry) => entry.count === 3)!.lastAt, '2026-11-19T10:00:00.000Z');

      const setup = testContext('', { setupPassword: testSetupPassword });
      const setupApp = buildApp(setup);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await setupApp.inject({ method: 'POST', url: '/api/setup', headers: csrf, payload: { ...testAdmin, setupPassword: 'wrong' } });
      }
      assert.deepEqual(setup.logs.listAudit({}, null, 10).map((entry) => [entry.action, entry.outcome, entry.count]), [['createAdmin', 'denied', 2]]);
      await setupApp.close();
      setup.close();
    } finally {
      await close();
    }
  });

  it('stores pseudonymous address hashes, never addresses, passwords or submitted values (LOG-9, LOG-12, LOG-14)', async () => {
    const { app, context, close } = loggedServer();
    try {
      await app.inject({ method: 'POST', url: '/api/setup', remoteAddress: '203.0.113.7', headers: csrf, payload: { setupPassword: testSetupPassword, ...testAdmin } });
      const cookie = (await adminWriteHeaders(context)).cookie;
      await app.inject({ method: 'POST', url: '/api/admin/password', remoteAddress: '2001:db8:1:2:3:4:5:6', headers: { cookie, ...csrf }, payload: { currentPassword: testAdmin.password, password: 'Secret-New-Password-9' } });
      await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie, ...csrf }, payload: { values: { 'site.title': '' } } });
      const everything = JSON.stringify([audits(context), serverEntries(context)]);
      for (const secret of ['203.0.113.7', '2001:db8', testAdmin.password, testSetupPassword, 'Secret-New-Password-9', cookie.split('=')[1]]) {
        assert.ok(!everything.includes(secret), `${secret} never reaches the logs`);
      }
      const hashes = audits(context).map((entry) => entry.ipHash);
      assert.ok(hashes.every((hash) => hash && /^[0-9a-f]{16}$/.test(hash)));
      assert.equal(context.logs.ipHash('203.0.113.7'), context.logs.ipHash('::ffff:203.0.113.7'));
      assert.equal(context.logs.ipHash('2001:db8:1:2:3:4:5:6'), context.logs.ipHash('2001:db8:1:2:ffff::1'), 'one /64 is one hash');
      assert.notEqual(context.logs.ipHash('2001:db8:1:2::1'), context.logs.ipHash('2001:db8:1:3::1'));
    } finally {
      await close();
    }
  });

  it('normalizes addresses before hashing (LOG-12)', () => {
    assert.equal(normalizeAddress('::ffff:192.0.2.1'), '192.0.2.1');
    assert.equal(normalizeAddress('192.0.2.1'), '192.0.2.1');
    assert.equal(normalizeAddress('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(normalizeAddress('2001:DB8:a:b:c:d:e:f'), '2001:db8:a:b::/64');
  });

  it('has no route that edits or deletes audit entries (LOG-18)', () => {
    assert.ok(!apiRoutes.some((route) => route.url.startsWith('/api/admin/logs/audit') && route.method !== 'GET'));
  });
});

describe('the server log (LOG-5..LOG-9)', () => {
  it('stores info and above from the logger, not debug entries or access logs', async () => {
    const { app, context, logger, close } = loggedServer();
    try {
      logger.info({ source: 'startup', version: '1.2.3' }, 'Started.');
      logger.debug({ source: 'startup' }, 'Debugging detail.');
      logger.warn({ source: 'config' }, 'A warning.');
      await app.inject('/api/health');
      const entries = serverEntries(context);
      assert.deepEqual(entries.map((entry) => [entry.level, entry.source, entry.message]), [['warn', 'config', 'A warning.'], ['info', 'startup', 'Started.']]);
      assert.deepEqual(entries[1].details, { version: '1.2.3' });
      assert.ok(entries.every((entry) => /^[0-9a-f-]{36}$/.test(entry.id) && entry.at.endsWith('Z')));
    } finally {
      await close();
    }
  });

  it('writes an unexpected error with its stack and the audit entry\'s request ID', async () => {
    const { app, context, close } = loggedServer();
    try {
      const cookie = await adminCookie(context);
      context.db.close();
      const response = await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie, ...csrf }, payload: { values: {} } });
      assert.equal(response.statusCode, 500);
      const [error] = serverEntries(context).filter((entry) => entry.level === 'error');
      const [audit] = audits(context);
      assert.equal(error.source, 'http');
      assert.ok(error.requestId);
      assert.equal(audit.requestId, error.requestId);
      assert.equal(audit.outcome, 'failure');
      assert.match(String((error.details.error as { stack?: string }).stack), /Error/);
      assert.ok(!JSON.stringify(error).includes(cookie.split('=')[1]), 'no cookies or headers');
    } finally {
      await close();
    }
  });

  it('turns pino records into entries, dropping levels below info', () => {
    assert.equal(serverEntryFromRecord({ level: 20, msg: 'debug' }), null);
    const entry = serverEntryFromRecord({ level: 50, time: 0, msg: 'Boom', reqId: 'r1', err: { type: 'Error', message: 'x', stack: 's' }, route: '/api/x', req: { headers: { cookie: 'secret' } } })!;
    assert.deepEqual([entry.level, entry.source, entry.requestId, entry.at], ['error', 'http', 'r1', '1970-01-01T00:00:00.000Z']);
    assert.deepEqual(entry.details, { error: { name: 'Error', message: 'x', stack: 's' }, route: '/api/x' });
  });

  it('never fails when the store cannot be written, and reports that once (LOG-3)', () => {
    const reports: string[] = [];
    const { store } = openLogStore(':memory:', { report: (message) => reports.push(message) });
    store.close();
    assert.doesNotThrow(() => store.writeServer(serverEntryFromRecord({ level: 30, msg: 'x' })!));
    assert.doesNotThrow(() => store.writeServer(serverEntryFromRecord({ level: 30, msg: 'y' })!));
    assert.equal(reports.length, 1);
    assert.match(reports[0], /could not write the server log/);
  });
});

describe('the log routes (LOG-18..LOG-22, API-8)', () => {
  it('pages newest first with a cursor, filters, and rejects a bad cursor or limit', async () => {
    const { app, context, logger, close } = loggedServer();
    try {
      for (let index = 0; index < 5; index += 1) logger.info({ source: index % 2 ? 'retention' : 'startup' }, `Entry ${index}`);
      logger.error({ source: 'backup' }, 'Broken backup');
      const cookie = await adminCookie(context);
      const get = (query: string) => app.inject({ url: `/api/admin/logs/server${query}`, headers: { cookie } });
      const first = (await get('?limit=2')).json();
      assert.deepEqual(first.items.map((entry: { message: string }) => entry.message), ['Broken backup', 'Entry 4']);
      const second = (await get(`?limit=2&cursor=${first.nextCursor}`)).json();
      assert.deepEqual(second.items.map((entry: { message: string }) => entry.message), ['Entry 3', 'Entry 2']);
      logger.info({ source: 'startup' }, 'Written while paging');
      const third = (await get(`?limit=2&cursor=${second.nextCursor}`)).json();
      assert.deepEqual(third.items.map((entry: { message: string }) => entry.message), ['Entry 1', 'Entry 0'], 'new entries never shift a page');
      assert.equal(third.nextCursor, null, 'the last page has no cursor');
      assert.deepEqual((await get('?level=error')).json().items.map((entry: { message: string }) => entry.message), ['Broken backup']);
      assert.deepEqual((await get('?source=retention')).json().items.length, 2);
      assert.deepEqual((await get('?q=entry%203')).json().items.map((entry: { message: string }) => entry.message), ['Entry 3']);
      assert.equal((await get('?q=%25')).json().items.length, 0, 'wildcards are literal');
      for (const query of ['?cursor=@@@', `?cursor=${Buffer.from('abc').toString('base64url')}`, '?limit=201', '?limit=0', '?level=debug', '?from=yesterday', '?extra=1']) {
        const response = await get(query);
        assert.equal(response.statusCode, 400, query);
        assert.equal(response.json().error, 'invalid_request', query);
      }
      assert.equal(decodeLogCursor(encodeLogCursor(42)), 42);
    } finally {
      await close();
    }
  });

  it('summarizes unseen warnings and errors until the log is seen, and clears the server log (LOG-20, LOG-21)', async () => {
    const { app, context, logger, close } = loggedServer();
    try {
      const headers = await adminWriteHeaders(context);
      logger.warn({ source: 'config' }, 'w');
      logger.error({ source: 'http' }, 'e');
      logger.fatal({ source: 'startup' }, 'f');
      const summary = () => app.inject({ url: '/api/admin/logs/server/summary', headers: { cookie: headers.cookie } }).then((response) => response.json());
      assert.deepEqual(await summary(), { unseenWarnings: 1, unseenErrors: 2 });
      assert.equal((await app.inject({ method: 'POST', url: '/api/admin/logs/server/seen', headers })).statusCode, 204);
      assert.deepEqual(await summary(), { unseenWarnings: 0, unseenErrors: 0 });
      assert.equal((await app.inject({ method: 'DELETE', url: '/api/admin/logs/server', headers })).statusCode, 204);
      assert.equal(serverEntries(context).length, 0);
      const [cleared] = audits(context);
      assert.deepEqual([cleared.action, cleared.outcome], ['clearServerLog', 'success']);
      assert.ok(audits(context).length > 0, 'the audit log is untouched');
    } finally {
      await close();
    }
  });

  it('exports JSON Lines and CSV with formula-like cells neutralized, and audits the export', async () => {
    const { app, context, logger, close } = loggedServer();
    try {
      logger.info({ source: 'startup' }, '=HYPERLINK("http://evil")');
      const cookie = await adminCookie(context);
      const csv = await app.inject({ url: '/api/admin/logs/server/export?format=csv&source=startup', headers: { cookie } });
      assert.equal(csv.statusCode, 200);
      assert.match(String(csv.headers['content-type']), /^text\/csv/);
      assert.match(String(csv.headers['content-disposition']), /^attachment; filename="agt-trivia-server-log-\d{4}-\d{2}-\d{2}T[\d-]+Z\.csv"$/);
      const [header, row] = csv.body.split('\r\n');
      assert.equal(header, 'id,at,level,source,message,requestId,details');
      assert.match(row, /,"'=HYPERLINK\(""http:\/\/evil""\)",/);
      const jsonl = await app.inject({ url: '/api/admin/logs/audit/export?format=jsonl', headers: { cookie } });
      assert.match(String(jsonl.headers['content-type']), /^application\/x-ndjson/);
      for (const line of jsonl.body.trim().split('\n')) assert.ok(JSON.parse(line).action);
      const [exported] = audits(context);
      assert.deepEqual([exported.action, exported.details], ['exportAuditLog', { format: 'jsonl', filters: {} }]);
      for (const [value, cell] of [['+1', "'+1"], ['-x', "'-x"], ['@a', "'@a"], ['\tx', "'\tx"], ['plain', 'plain'], ['a,b', '"a,b"']]) assert.equal(csvCell(value), cell);
    } finally {
      await close();
    }
  });
});

describe('retention (LOG-15, LOG-16)', () => {
  it('deletes by age, then by cap with non-success audit entries first, and logs what it deleted', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const context = testContext('', { now: () => now });
    try {
      const old = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      const audit = (outcome: 'success' | 'failure', action: string) => context.logs.audit({
        actorType: 'anonymous', actor: null, ipHash: action, client: 'api', action, method: 'POST', route: '/x', targetType: null, targetId: null, outcome, statusCode: outcome === 'success' ? 200 : 400, requestId: null, details: {},
      });
      const writeAt = (at: Date, write: () => void) => { const saved = now; now = at; write(); now = saved; };
      writeAt(old(40), () => context.logs.writeServer({ ...serverEntryFromRecord({ level: 30, msg: 'old' })!, at: old(40).toISOString() }));
      context.logs.writeServer(serverEntryFromRecord({ level: 30, msg: 'new' })!);
      writeAt(old(400), () => audit('success', 'ancient'));
      audit('success', 's1');
      audit('failure', 'f1');
      audit('success', 's2');
      audit('failure', 'f2');
      const logged: string[] = [];
      const log = { info: (_details: object, message: string) => logged.push(message), error: (_details: object, message: string) => logged.push(message) };
      const retention = startRetention(context.logs, () => ({ serverRetentionDays: 30, serverMaxEntries: 1000, auditRetentionDays: 365, auditMaxEntries: 3 }), log);
      retention.stop();
      assert.deepEqual(context.logs.listServer({}, null, 10).map((entry) => entry.message), ['new']);
      assert.deepEqual(context.logs.listAudit({}, null, 10).map((entry) => entry.action), ['f2', 's2', 's1'], 'the ancient entry by age, then the oldest failure by cap');
      assert.deepEqual(logged, ['Retention deleted 1 server log and 2 audit log entries.']);
      assert.deepEqual(context.logs.applyRetention({ serverRetentionDays: 30, serverMaxEntries: 1000, auditRetentionDays: 365, auditMaxEntries: 2 }), { server: 0, audit: 1 });
      assert.deepEqual(context.logs.listAudit({}, null, 10).map((entry) => entry.action), ['s2', 's1'], 'with no failures left, the oldest successes go');
    } finally {
      context.close();
    }
  });

  it('keeps the audit log for at least 30 days (LOG-16)', () => {
    assert.equal(validSetting('logs.auditRetentionDays', 29), false);
    assert.equal(validSetting('logs.auditRetentionDays', 30), true);
    assert.equal(validSetting('logs.serverRetentionDays', 1), true);
    assert.equal(validSetting('logs.auditMaxEntries', 9999), false);
    assert.throws(() => parseConfig('logs:\n  auditRetentionDays: 7\n'), /logs\.auditRetentionDays/);
  });
});
