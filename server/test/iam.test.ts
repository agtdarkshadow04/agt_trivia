import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';
import { IamClient, parseExpiresIn } from '../iam.js';
import { adminCookie, testContext, type TestContext } from './helpers.js';

/**
 * AGT sign-in through AGT IAM (#18), against a fake AGT IAM on a loopback
 * port: the client's answer mapping, then sign-in through the app (the
 * first sign-in creating the member, the role map, the Admin's limits on
 * AGT members, and `iam.enabled` switching off).
 */

const csrf = { 'x-agt-request': '1' };
const apiKey = 'fake-iam-api-key';
const agtPassword = 'q"uo,te+s\\ok';

interface Traveller {
  id: string;
  name: string;
  password: string;
  permission: string;
  isAuthorized?: boolean;
  expiresIn?: string;
}

let travellers: Traveller[] = [];
let calls: { identifier: string; password: string; appId: string; key: string | undefined }[] = [];
/** A canned answer for the next calls, instead of the travellers. */
let canned: ((response: http.ServerResponse) => void) | null = null;
/** When set, IAM holds its answer until the promise resolves. */
let hold: Promise<void> | null = null;

const iam = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', async () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { identifier: string; password: string; appId: string };
    calls.push({ ...body, key: request.headers['x-api-key'] as string | undefined });
    if (hold) await hold;
    if (canned) { canned(response); return; }
    const traveller = travellers.find((candidate) => candidate.name === body.identifier);
    response.setHeader('content-type', 'application/json');
    if (!traveller || traveller.password !== body.password) {
      response.writeHead(401).end(JSON.stringify({ error: traveller ? 'ERR_INVALID_CREDENTIALS' : 'ERR_IDENTITY_NOT_FOUND' }));
      return;
    }
    response.writeHead(200).end(JSON.stringify({
      authenticated: true,
      verified: true,
      token: 'iam-token-never-stored',
      traveller: { travellerName: traveller.name, agtTravellerId: traveller.id, agtStatus: 'Active', securityLevel: '2' },
      applicationAuthorization: { requestedAppId: body.appId, permissionAssigned: traveller.permission, isAuthorized: traveller.isAuthorized ?? true, accessNotes: '' },
      metadata: { issuer: 'AGT-IAM', expiresIn: traveller.expiresIn ?? '24h', timestamp: new Date().toISOString() },
    }));
  });
});

let iamUrl = '';

before(async () => {
  await new Promise<void>((resolve) => iam.listen(0, '127.0.0.1', resolve));
  iamUrl = `http://127.0.0.1:${(iam.address() as AddressInfo).port}`;
});

after(async () => {
  iam.closeAllConnections();
  await new Promise((resolve) => iam.close(resolve));
});

beforeEach(() => {
  travellers = [
    { id: 'AGT-1001', name: 'Atlas Walker', password: agtPassword, permission: 'Traveller' },
    { id: 'AGT-1002', name: 'Nova Editor', password: agtPassword, permission: 'Editor' },
    { id: 'AGT-1003', name: 'No Access', password: agtPassword, permission: 'NOACCESS' },
    { id: 'AGT-1004', name: 'Not Authorized', password: agtPassword, permission: 'Moderator', isAuthorized: false },
  ];
  calls = [];
  canned = null;
  hold = null;
});

const iamConfig = (extra = '') => `iam:\n  enabled: true\n  baseUrl: ${iamUrl}\n  appId: agt-trivia-test\n  timeoutSeconds: 1\n  roleMap: { Editor: Editor, Moderator: Moderator }\n${extra}`;

function logSpy() {
  return { error: mock.fn((_message: string) => undefined), warn: mock.fn((_message: string) => undefined) };
}

describe('the AGT IAM client (#18)', () => {
  const client = (log = logSpy(), config = iamConfig()) => ({ log, client: new IamClient({ config: parseConfig(config), iamApiKey: apiKey }, log) });

  it('sends the name, password, App ID and key once, and maps the tier through iam.roleMap, Player by default', async () => {
    const { client: iamClient } = client();
    const traveller = await iamClient.verify('Atlas Walker', agtPassword);
    assert.deepEqual(traveller, { travellerId: 'AGT-1001', travellerName: 'Atlas Walker', permission: 'Traveller', role: 'Player', expiresInSeconds: 86_400 });
    assert.deepEqual(calls, [{ identifier: 'Atlas Walker', password: agtPassword, appId: 'agt-trivia-test', key: apiKey }]);
    assert.equal((await iamClient.verify('Nova Editor', agtPassword)).role, 'Editor');
    const { client: moderatorDefault } = client(logSpy(), iamConfig('  defaultRole: Moderator\n'));
    assert.equal((await moderatorDefault.verify('Atlas Walker', agtPassword)).role, 'Moderator');
  });

  it('refuses wrong credentials, the NOACCESS and NONE tiers and unauthorized travellers', async () => {
    const { client: iamClient } = client();
    await assert.rejects(iamClient.verify('Atlas Walker', 'wrong'), { error: 'invalid_credentials', statusCode: 401 });
    await assert.rejects(iamClient.verify('Nobody', agtPassword), { error: 'invalid_credentials' });
    await assert.rejects(iamClient.verify('No Access', agtPassword), { error: 'app_access_denied', statusCode: 403 });
    await assert.rejects(iamClient.verify('Not Authorized', agtPassword), { error: 'app_access_denied' });
    travellers.push({ id: 'AGT-1005', name: 'None Tier', password: agtPassword, permission: 'none' });
    await assert.rejects(iamClient.verify('None Tier', agtPassword), { error: 'app_access_denied' });
  });

  it('maps IAM failures without retrying, logging only IAM\'s error code', async () => {
    const answers: [(response: http.ServerResponse) => void, string, number][] = [
      [(response) => response.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"ERR_APP_NOT_ALLOWED"}'), 'iam_unavailable', 503],
      [(response) => response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"ERR_INVALID_API_KEY"}'), 'iam_unavailable', 503],
      [(response) => response.writeHead(429, { 'retry-after': '30' }).end('{}'), 'rate_limited', 429],
      [(response) => response.writeHead(500).end('{"error":"INTERNAL"}'), 'iam_bad_gateway', 502],
      [(response) => response.writeHead(200).end('not json'), 'iam_bad_gateway', 502],
      [(response) => response.writeHead(200).end('{"authenticated":true}'), 'iam_bad_gateway', 502],
      [(response) => response.writeHead(200).end(JSON.stringify({ authenticated: true, traveller: { agtTravellerId: 'x' }, applicationAuthorization: { requestedAppId: 'other-app', permissionAssigned: 'Editor', isAuthorized: true } })), 'iam_bad_gateway', 502],
      [(response) => response.writeHead(200).end(JSON.stringify({ authenticated: false })), 'invalid_credentials', 401],
      [(response) => response.writeHead(302, { location: 'https://elsewhere.example/' }).end(), 'iam_bad_gateway', 502],
      [(response) => response.writeHead(200).end(`{"pad":"${'x'.repeat(70 * 1024)}"}`), 'iam_bad_gateway', 502],
    ];
    for (const [answer, error, statusCode] of answers) {
      canned = answer;
      calls = [];
      const log = logSpy();
      const { client: iamClient } = client(log);
      await assert.rejects(iamClient.verify('Atlas Walker', agtPassword), (thrown: { error: string; statusCode: number }) => thrown.error === error && thrown.statusCode === statusCode, error);
      assert.equal(calls.length, 1, `${error}: never retried`);
      const logged = JSON.stringify([log.error.mock.calls, log.warn.mock.calls]);
      assert.doesNotMatch(logged, new RegExp(apiKey));
      assert.doesNotMatch(logged, /uo,te/);
    }
  });

  it('gives up after iam.timeoutSeconds with 504 iam_timeout', async () => {
    let release!: () => void;
    hold = new Promise((resolve) => { release = resolve; });
    const { client: iamClient } = client();
    try {
      await assert.rejects(iamClient.verify('Atlas Walker', agtPassword), { error: 'iam_timeout', statusCode: 504 });
    } finally {
      release();
    }
  });

  it('reads IAM\'s token lifetime and cuts long traveller names', async () => {
    assert.equal(parseExpiresIn('90m'), 5400);
    assert.equal(parseExpiresIn(3600), 3600);
    assert.equal(parseExpiresIn('2d'), 172_800);
    assert.equal(parseExpiresIn('soon'), undefined);
    travellers.push({ id: 'AGT-1006', name: 'N'.repeat(60), password: agtPassword, permission: 'Traveller' });
    const { client: iamClient } = client();
    assert.equal((await iamClient.verify('N'.repeat(60), agtPassword)).travellerName.length, 42);
  });

  it('allows https://, and http:// only to a loopback host, without credentials in the URL', () => {
    for (const url of ['https://iam.example.org', 'http://localhost:4000', 'http://127.0.0.1:4000/base']) assert.doesNotThrow(() => parseConfig(`iam:\n  baseUrl: ${url}\n`), url);
    for (const url of ['http://iam.example.org', 'https://user:secret@iam.example.org', 'ftp://iam.example.org']) {
      assert.throws(() => parseConfig(`iam:\n  baseUrl: ${url}\n`), /iam\.baseUrl/, url);
    }
  });
});

describe('AGT sign-in through the app (#18)', () => {
  let context: TestContext;
  let app: FastifyInstance;
  const signIn = (travellerName: string, password = agtPassword) => app.inject({ method: 'POST', url: '/api/member/iam/login', headers: csrf, payload: { travellerName, password } });
  const cookieOf = (response: LightMyRequestResponse) => `agt_trivia_member_session=${/^agt_trivia_member_session=([^;]*)/.exec(String(response.headers['set-cookie']))?.[1]}`;
  const session = async (cookie: string) => app.inject({ url: '/api/member/session', headers: { cookie } });
  const members = () => context.db.connection.prepare("SELECT username, password_hash, role, iam_traveller_id, iam_permission, display_name FROM members WHERE auth_source = 'agt_iam' ORDER BY iam_traveller_id").all();

  beforeEach(async () => {
    context = testContext(iamConfig(), { iamApiKey: apiKey });
    app = buildApp(context);
    await app.ready();
  });

  after(async () => {
    await app?.close();
    context?.close();
  });

  it('creates the member at the first sign-in, as a Player, without a username or password', async () => {
    try {
      const response = await signIn('Atlas Walker');
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { id: response.json().id, username: null, displayName: 'Atlas Walker', role: 'Player', authSource: 'agt_iam' });
      assert.equal((await session(cookieOf(response))).json().displayName, 'Atlas Walker');
      assert.deepEqual(members().map((row) => ({ ...row as object })), [{
        username: null, password_hash: null, role: 'Player', iam_traveller_id: 'AGT-1001', iam_permission: 'Traveller', display_name: 'Atlas Walker',
      }]);
      // #48: the sign-in is recorded.
      const lastSignIn = () => (context.db.connection.prepare("SELECT last_sign_in_at FROM members WHERE iam_traveller_id = 'AGT-1001'").get() as { last_sign_in_at: string | null }).last_sign_in_at;
      const first = lastSignIn();
      assert.ok(first);
      // The second sign-in finds the same member.
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal((await signIn('Atlas Walker')).json().id, response.json().id);
      assert.ok(lastSignIn()! > first);
      assert.equal(members().length, 1);
      // Neither the password nor IAM's token is kept anywhere (logs included).
      const everything = JSON.stringify([members(), context.logs.listAudit({}, null, 100), context.logs.listServer?.({}, null, 100)]);
      assert.doesNotMatch(everything, /uo,te|iam-token-never-stored/);
    } finally {
      await app.close();
      context.close();
    }
  });

  it('sets the role from the tier at every sign-in, a change ending the member\'s other sessions', async () => {
    try {
      const first = await signIn('Nova Editor');
      assert.equal(first.json().role, 'Editor');
      const cookie = cookieOf(first);
      travellers[1].permission = 'Moderator';
      const promoted = await signIn('Nova Editor');
      assert.equal(promoted.json().role, 'Moderator');
      assert.equal((await session(cookie)).statusCode, 401, 'the old session ended');
      assert.equal((await session(cookieOf(promoted))).statusCode, 200);
      travellers[1].permission = 'Unknown tier';
      assert.equal((await signIn('Nova Editor')).json().role, 'Player', 'a tier the map does not name gets the default');
    } finally {
      await app.close();
      context.close();
    }
  });

  it('creates nothing for a refused tier or wrong credentials', async () => {
    try {
      assert.equal((await signIn('No Access')).json().error, 'app_access_denied');
      assert.equal((await signIn('Not Authorized')).json().error, 'app_access_denied');
      assert.equal((await signIn('Atlas Walker', 'wrong')).json().error, 'invalid_credentials');
      assert.deepEqual(members(), []);
    } finally {
      await app.close();
      context.close();
    }
  });

  it('asks IAM outside the data write, so a slow IAM never holds a backup up (BAK-8)', async () => {
    try {
      let release!: () => void;
      hold = new Promise((resolve) => { release = resolve; });
      const pending = signIn('Atlas Walker');
      while (calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      // A backup's drain waits only for data writes in progress: none while IAM thinks.
      await context.operations.begin('backup');
      context.operations.end('idle');
      release();
      assert.equal((await pending).statusCode, 200);
    } finally {
      await app.close();
      context.close();
    }
  });

  it('lets the Admin only activate, deactivate or delete an AGT member', async () => {
    try {
      const signedIn = await signIn('Atlas Walker');
      const id = signedIn.json().id as string;
      const admin = await adminCookie(context);
      const replace = (body: object) => app.inject({ method: 'PUT', url: `/api/admin/members/${id}`, headers: { cookie: admin, ...csrf }, payload: body });
      assert.equal((await replace({ displayName: 'Renamed', role: 'Player', isActive: true })).json().error, 'managed_by_iam');
      assert.equal((await replace({ displayName: 'Atlas Walker', role: 'Moderator', isActive: true })).json().error, 'managed_by_iam');
      const password = await app.inject({ method: 'POST', url: `/api/admin/members/${id}/password`, headers: { cookie: admin, ...csrf }, payload: { password: 'Another-Password-1!' } });
      assert.equal(password.json().error, 'managed_by_iam');
      const listed = (await app.inject({ url: '/api/admin/members', headers: { cookie: admin } })).json().items[0];
      assert.deepEqual([listed.travellerId, listed.iamPermission, listed.username], ['AGT-1001', 'Traveller', null]);
      // Deactivated: signed out, and IAM's yes is not enough to sign in again.
      assert.equal((await replace({ displayName: 'Atlas Walker', role: 'Player', isActive: false })).statusCode, 200);
      assert.equal((await session(cookieOf(signedIn))).statusCode, 401);
      assert.equal((await signIn('Atlas Walker')).json().error, 'invalid_credentials');
      assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/members/${id}`, headers: { cookie: admin, ...csrf } })).statusCode, 204);
      // A deleted AGT member is created anew at their next sign-in.
      assert.equal((await signIn('Atlas Walker')).statusCode, 200);
    } finally {
      await app.close();
      context.close();
    }
  });

  it('turns off with iam.enabled: sign-in refused, AGT sessions ended, local members unaffected', async () => {
    try {
      // The setting is the dashboard's here, so the config file must not set it.
      await app.close();
      context.close();
      context = testContext(iamConfig().replace('  enabled: true\n', ''), { iamApiKey: apiKey });
      app = buildApp(context);
      const admin = await adminCookie(context);
      const settings = (enabled: boolean) => app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie: admin, ...csrf }, payload: { values: { 'iam.enabled': enabled } } });
      assert.equal((await signIn('Atlas Walker')).json().error, 'iam_disabled');
      assert.equal((await app.inject('/api/settings/public')).json().agtSignIn, false);
      const enabled = await settings(true);
      assert.deepEqual(enabled.json().iam, { enabled: true, available: true, missing: [] });
      assert.equal((await app.inject('/api/settings/public')).json().agtSignIn, true);
      const cookie = cookieOf(await signIn('Atlas Walker'));
      assert.equal((await session(cookie)).statusCode, 200);
      await settings(false);
      assert.equal((await session(cookie)).statusCode, 401);
      assert.equal((context.db.connection.prepare('SELECT count(*) AS n FROM member_sessions').get() as { n: number }).n, 0);
      assert.equal((await signIn('Atlas Walker')).json().error, 'iam_disabled');
    } finally {
      await app.close();
      context.close();
    }
  });

  it('is unavailable while something is missing, and says what in Settings', async () => {
    try {
      await app.close();
      context.close();
      context = testContext(iamConfig(), { iamApiKey: null });
      app = buildApp(context);
      assert.equal((await signIn('Atlas Walker')).json().error, 'iam_unavailable');
      assert.equal(calls.length, 0, 'IAM is never asked');
      const admin = await adminCookie(context);
      assert.deepEqual((await app.inject({ url: '/api/admin/settings', headers: { cookie: admin } })).json().iam, { enabled: true, available: false, missing: ['apiKey'] });
    } finally {
      await app.close();
      context.close();
    }
  });
});
