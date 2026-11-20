import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp, maxBodyBytes } from '../app.js';
import { errorReply, HttpError, RateLimitedError } from '../http.js';
import { apiRoutes } from '../routes.js';
import { adminCookie, createMember, memberCookie, seedQuiz, testContext, totalChanges } from './helpers.js';

describe('the route table', () => {
  const context = testContext();
  let app: FastifyInstance;
  before(async () => { app = buildApp(context); await app.ready(); });
  after(async () => { await app.close(); context.close(); });

  it('declares writesData on every registered /api/ route (BAK-8)', async () => {
    const registered: { method: string; url: string; writesData: unknown }[] = [];
    const probe = buildApp(context);
    probe.addHook('onRoute', (route) => {
      if (!route.url.startsWith('/api/') || route.url === '/api/openapi.json' || route.method === 'HEAD') return;
      registered.push({ method: String(route.method), url: route.url, writesData: route.config?.apiRoute?.writesData });
    });
    await probe.ready();
    assert.ok(registered.length >= apiRoutes.length);
    for (const route of registered) assert.equal(typeof route.writesData, 'boolean', `${route.method} ${route.url}`);
    await probe.close();
  });

  it('has unique operation IDs and only GET routes without writesData that write nothing', async () => {
    assert.equal(new Set(apiRoutes.map((route) => route.operationId)).size, apiRoutes.length);
    const cookie = await adminCookie(context);
    const { category } = await seedQuiz(context);
    await createMember(context, 'route.tester');
    const member = await memberCookie(context, 'route.tester');
    const credentials = { admin: { cookie }, member: { cookie: member }, none: {}, csrf: {} };
    const queries: Record<string, string> = { '/export': '?format=jsonl', '/quiz': '?length=all' };
    for (const route of apiRoutes.filter((entry) => entry.method === 'GET')) {
      assert.equal(route.writesData, false, route.url);
      const before = totalChanges(context);
      const query = Object.entries(queries).find(([suffix]) => route.url.endsWith(suffix))?.[1] ?? '';
      const url = route.url.replace(':id', category.id);
      const response = await app.inject({ url: `${url}${query}`, headers: credentials[route.auth] });
      assert.equal(response.statusCode, 200, route.url);
      assert.equal(totalChanges(context), before, `${route.url} writes nothing (BAK-8)`);
    }
  });

  it('answers the health check after querying the database (SRV-11)', async () => {
    const broken = testContext();
    const brokenApp = buildApp(broken);
    broken.db.close();
    try {
      const response = await brokenApp.inject('/api/health');
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), { error: 'internal', message: 'An unexpected server error occurred.' });
    } finally {
      await brokenApp.close();
    }
  });
});

describe('error bodies (API-6, SRV-5)', () => {
  const context = testContext();
  let app: FastifyInstance;
  before(async () => { app = buildApp(context); await app.ready(); });
  after(async () => { await app.close(); context.close(); });

  it('rejects an undeclared query parameter with 400 invalid_request (API-10)', async () => {
    const response = await app.inject('/api/settings/public?extra=1');
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: 'invalid_request', message: 'The request is invalid.' });
  });

  it('answers an unknown method or route with 404 not_found (SRV-10)', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/health' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, 'not_found');
  });

  it('maps HttpError with fields and params, and sends Retry-After for rate limits', () => {
    const validation = errorReply(new HttpError(400, 'validation_failed', 'Bad.', { fields: [{ field: 'name', code: 'required', message: 'Name is required.' }] }), { maxBodyBytes });
    assert.deepEqual(validation.body, { error: 'validation_failed', message: 'Bad.', fields: [{ field: 'name', code: 'required', message: 'Name is required.' }] });
    const limited = errorReply(new RateLimitedError(42), { maxBodyBytes });
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(limited.body.params, { retryAfterSeconds: 42 });
    assert.equal(limited.headers['retry-after'], '42');
  });

  it('turns schema failures into field errors that each have a code', () => {
    const error = Object.assign(new Error('schema'), {
      validationContext: 'body',
      validation: [
        { keyword: 'required', instancePath: '', params: { missingProperty: 'prompt' } },
        { keyword: 'maxLength', instancePath: '/choices/2', params: { limit: 200 } },
        { keyword: 'additionalProperties', instancePath: '', params: { additionalProperty: 'extra' } },
        { keyword: 'type', instancePath: '/priority', params: {} },
      ],
    });
    const reply = errorReply(error, { maxBodyBytes });
    assert.equal(reply.statusCode, 400);
    assert.equal(reply.body.error, 'validation_failed');
    assert.deepEqual(reply.body.fields, [
      { field: 'prompt', code: 'required', message: 'prompt is required.' },
      { field: 'choices.2', code: 'too_long', message: 'choices.2 must be at most 200 characters.', params: { max: 200 } },
      { field: 'extra', code: 'not_allowed', message: 'extra is not allowed.' },
      { field: 'priority', code: 'invalid_format', message: 'priority has the wrong type or format.' },
    ]);
    const query = errorReply(Object.assign(error, { validationContext: 'querystring' }), { maxBodyBytes });
    assert.deepEqual(query.body, { error: 'invalid_request', message: 'The request is invalid.' });
  });

  it('answers a body over the limit with 413 and maxBytes', () => {
    const reply = errorReply(Object.assign(new Error('too large'), { code: 'FST_ERR_CTP_BODY_TOO_LARGE', statusCode: 413 }), { maxBodyBytes });
    assert.equal(reply.statusCode, 413);
    assert.deepEqual(reply.body, { error: 'body_too_large', message: 'The request body is too large.', params: { maxBytes: maxBodyBytes } });
  });

  it('never exposes an unexpected error, and reports it', () => {
    const reported: unknown[] = [];
    const reply = errorReply(new Error('secret detail'), { maxBodyBytes, onUnexpected: (error) => reported.push(error) });
    assert.equal(reply.statusCode, 500);
    assert.deepEqual(reply.body, { error: 'internal', message: 'An unexpected server error occurred.' });
    assert.equal(reported.length, 1);
  });
});
