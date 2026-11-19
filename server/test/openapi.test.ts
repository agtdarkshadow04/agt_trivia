import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { routeSecurity, SECURITY } from '../openapi.js';
import { apiRoutes } from '../routes.js';
import { errorCodes } from '../schemas.js';
import { testContext } from './helpers.js';

interface Operation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  security?: unknown;
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}

/** API-13: the generated document describes every route completely. */
describe('the OpenAPI document (API-10..API-13)', () => {
  const context = testContext();
  let app: FastifyInstance;
  let document: { openapi: string; info: { title: string; version: string }; paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, { properties: Record<string, { description?: string }> }> } };
  const registered: { method: string; url: string }[] = [];

  before(async () => {
    app = buildApp(context);
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        if (method === 'HEAD' || !route.url.startsWith('/api/') || (route.schema as { hide?: boolean } | undefined)?.hide) continue;
        registered.push({ method: method.toLowerCase(), url: route.url });
      }
    });
    await app.ready();
    const response = await app.inject('/api/openapi.json');
    assert.equal(response.statusCode, 200);
    document = response.json();
  });
  after(async () => { await app.close(); context.close(); });

  it('is OpenAPI 3.1.0 with the version the context carries (API-11, API-12, VER-2)', () => {
    assert.equal(document.openapi, '3.1.0');
    assert.equal(document.info.title, 'AGT Galactic Trivia API');
    assert.equal(document.info.version, context.version);
  });

  it('describes every registered /api/ route, and nothing else', () => {
    const documented = Object.entries(document.paths).flatMap(([path, operations]) => Object.keys(operations).map((method) => `${method} ${path}`)).sort();
    const routes = registered.map((route) => `${route.method} ${route.url.replace(/:([A-Za-z]+)/g, '{$1}')}`).sort();
    assert.deepEqual(documented, routes);
    assert.ok(!('/api/openapi.json' in document.paths), 'the document does not describe itself');
  });

  it('gives every operation a unique operationId, tags, a summary, a 2xx schema and the error default', () => {
    const ids = new Set<string>();
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const name = `${method} ${path}`;
        assert.match(operation.operationId ?? '', /^[a-z][A-Za-z]+$/, name);
        assert.ok(!ids.has(operation.operationId!), `${name}: duplicate operationId`);
        ids.add(operation.operationId!);
        assert.ok(operation.tags?.length, `${name}: tags`);
        assert.ok(operation.summary?.endsWith('.'), `${name}: one-sentence summary`);
        const success = Object.entries(operation.responses ?? {}).filter(([status]) => /^2\d\d$/.test(status));
        assert.ok(success.length, `${name}: a 2xx response`);
        for (const [status, response] of success) {
          if (status !== '204') assert.ok(response.content?.['application/json']?.schema, `${name}: ${status} has a schema`);
        }
        assert.ok(operation.responses?.default, `${name}: default error response`);
      }
    }
  });

  it('declares the security each route really needs (API-11, API-13)', () => {
    for (const route of apiRoutes) {
      const operation = document.paths[route.url.replace(/:([A-Za-z]+)/g, '{$1}')][route.method.toLowerCase()];
      assert.deepEqual(operation.security, routeSecurity(route), `${route.method} ${route.url}`);
      if (route.auth === 'none') assert.deepEqual(operation.security, SECURITY.none);
    }
  });

  it('lists every error code in the ErrorBody schema and in docs/API.md (API-6)', () => {
    const description = document.components.schemas.ErrorBody.properties.error.description ?? '';
    const guide = readFileSync('docs/API.md', 'utf8');
    for (const code of errorCodes) {
      assert.match(description, new RegExp(`\`${code}\``), `ErrorBody lists ${code}`);
      assert.match(guide, new RegExp(`\\| \`${code}\` \\|`), `docs/API.md lists ${code}`);
    }
  });
});
