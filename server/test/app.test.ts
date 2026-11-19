import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { contentSecurityPolicy } from '../headers.js';

/** A built client with both entries, one hashed asset and one public file. */
function staticFixture() {
  const root = mkdtempSync(join(tmpdir(), 'agt-trivia-static-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>public</title>');
  writeFileSync(join(root, 'admin.html'), '<!doctype html><title>admin</title>');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'main-abc123.js'), 'export {};');
  mkdirSync(join(root, 'fonts'));
  writeFileSync(join(root, 'fonts', 'licence.txt'), 'licence');
  return root;
}

function assertSecurityHeaders(headers: Record<string, unknown>) {
  assert.equal(headers['content-security-policy'], contentSecurityPolicy);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(headers['access-control-allow-origin'], undefined);
}

function assertNoStore(headers: Record<string, unknown>) {
  assert.equal(headers['cache-control'], 'no-store, no-cache, must-revalidate, max-age=0');
  assert.equal(headers.pragma, 'no-cache');
  assert.equal(headers.expires, '0');
}

describe('the server shell', () => {
  let root: string;
  let app: FastifyInstance;

  before(async () => {
    root = staticFixture();
    app = buildApp({ version: '0.0.0-test' }, { staticDir: root });
    await app.ready();
  });

  after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('answers the health check (SRV-11)', async () => {
    const response = await app.inject('/api/health');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
    assertSecurityHeaders(response.headers);
    assertNoStore(response.headers);
  });

  it('serves both entries with the security headers and no caching (SRV-9, SEC-1..SEC-3)', async () => {
    for (const [path, title] of [['/', 'public'], ['/admin', 'admin']]) {
      const response = await app.inject(path);
      assert.equal(response.statusCode, 200, path);
      assert.match(response.body, new RegExp(`<title>${title}</title>`));
      assertSecurityHeaders(response.headers);
      assertNoStore(response.headers);
    }
    assert.equal((await app.inject('/admin')).headers['x-robots-tag'], 'noindex, nofollow');
  });

  it('redirects /admin/ to /admin (SRV-9)', async () => {
    const response = await app.inject('/admin/');
    assert.equal(response.statusCode, 301);
    assert.equal(response.headers.location, '/admin');
  });

  it('caches hashed assets forever and other files never (SRV-9)', async () => {
    const asset = await app.inject('/assets/main-abc123.js');
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(asset.headers.pragma, undefined);
    assertSecurityHeaders(asset.headers);
    const file = await app.inject('/fonts/licence.txt');
    assert.equal(file.statusCode, 200);
    assertNoStore(file.headers);
  });

  it('never serves the entry pages under their file names', async () => {
    assert.equal((await app.inject('/index.html')).statusCode, 404);
    assert.equal((await app.inject('/admin.html')).statusCode, 404);
  });

  it('answers unknown routes with the JSON error body (SRV-10, API-6)', async () => {
    for (const path of ['/api/unknown', '/no-such-page']) {
      const response = await app.inject(path);
      assert.equal(response.statusCode, 404, path);
      assert.match(String(response.headers['content-type']), /^application\/json/);
      assert.deepEqual(response.json(), { error: 'not_found', message: 'Route not found.' });
      assertSecurityHeaders(response.headers);
    }
  });

  it('never answers a preflight with CORS permission (SEC-6)', async () => {
    const response = await app.inject({ method: 'OPTIONS', url: '/api/health', headers: { origin: 'https://example.com', 'access-control-request-method': 'GET' } });
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['access-control-allow-methods'], undefined);
  });
});

describe('versioning (VER-1, VER-9)', () => {
  it('carries a SemVer version, and the newest CHANGELOG heading is that version', async () => {
    const { readFileSync } = await import('node:fs');
    const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    assert.match(version, /^\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/);
    const heading = readFileSync('CHANGELOG.md', 'utf8').match(/^## \[([^\]]+)\] - (Unreleased|\d{4}-\d{2}-\d{2})$/m);
    assert.equal(heading?.[1], version);
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { version: string; packages: Record<string, { version?: string }> };
    assert.equal(lock.version, version);
    assert.equal(lock.packages[''].version, version);
  });
});
