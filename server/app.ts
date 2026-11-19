import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { auditHook } from './audit.js';
import type { AppContext } from './context.js';
import { withDataWrite } from './dataWrite.js';
import { noStoreHeaders, securityHeaders } from './headers.js';
import { errorReply, HttpError, RateLimitedError, type ErrorReply } from './http.js';
import { registerOpenApi, routeSecurity } from './openapi.js';
import { apiRoutes, type RateLimitName, type RouteDefinition } from './routes.js';
import { Empty } from './schemas.js';
import { AdminAuthService, adminSessionCookie, clearedCookie, secureCookie } from './session.js';

/** The header every state-changing request to `/api/setup` and `/api/admin/*` must carry (SEC-5, NAME-3). */
export const csrfHeader = 'x-agt-request';

function isLoopback(address: string) {
  return address === '127.0.0.1' || address === '::1' || address.startsWith('127.') || address === '::ffff:127.0.0.1';
}

export interface BuildAppOptions {
  /** A pino logger, or `false` for none (tests). */
  logger?: FastifyServerOptions['loggerInstance'] | false;
  /** The built client (`dist/`); without it only the API is served. */
  staticDir?: string;
}

/** AUTH-5: JSON request bodies are at most 2 MiB. */
export const maxBodyBytes = 2 * 1024 * 1024;

declare module 'fastify' {
  interface FastifyContextConfig {
    /** The route table entry, for the hooks and the tests (`server/routes.ts`). */
    apiRoute?: RouteDefinition;
  }
}

/**
 * The Fastify app, fully configured but not listening (SRV-2), so tests can
 * use `inject()`. Every `/api/` route comes from the table in
 * `server/routes.ts`.
 */
export function buildApp(context: AppContext, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    ...(options.logger ? { loggerInstance: options.logger } : { logger: false }),
    // LOG-6: access logs are user activity, which the audit log covers.
    logController: new LogController({ disableRequestLogging: true }),
    // LOG-10: request IDs link an audit entry to its server log entry, across restarts too.
    genReqId: () => randomUUID(),
    // SEC-4: X-Forwarded-* only from the proxies config.yaml names.
    trustProxy: context.config.server.trustProxy,
    bodyLimit: maxBodyBytes,
    // Keeps the last value of a repeated query parameter, as a plain object of strings.
    routerOptions: { querystringParser: (query: string) => Object.fromEntries(new URLSearchParams(query)) },
    // Undeclared properties are rejected, not dropped, and values are never coerced (API-10).
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  // SEC-1..SEC-3 on every response, errors and static files included. Hashed assets override the cache headers.
  app.addHook('onRequest', async (_request, reply) => {
    reply.headers({ ...securityHeaders, ...noStoreHeaders });
  });

  app.register(fastifyCookie);
  app.decorateRequest('admin', null);
  app.decorateRequest('audit', null);
  app.decorateRequest('auditError', null);
  // LOG-11: one hook audits every request that needs it.
  app.addHook('onResponse', auditHook(context.logs));

  // SEC-4: one warning per process, the first time credentials arrive over plain HTTP from another machine.
  let plainHttpWarned = false;
  const auth = new AdminAuthService(context);

  /**
   * AUTH-9, SEC-5: the one hook that checks the CSRF header and the Admin
   * session, before the body is read. A state-changing `csrf` or `admin` route
   * without `x-agt-request: 1` gets `403 csrf`; an `admin` route without a valid
   * session gets `401 unauthorized`, and an unknown or expired cookie is cleared.
   * Rate limits run right after it, as `@fastify/rate-limit` route hooks.
   */
  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.config.apiRoute;
    if (!route || route.auth === 'none') return;
    if (route.rateLimit && !plainHttpWarned && request.protocol === 'http' && !isLoopback(request.ip)) {
      plainHttpWarned = true;
      request.log.warn({ source: 'security' }, 'A sign-in or setup request arrived over plain HTTP from another machine: credentials were sent unencrypted. Put a TLS-terminating reverse proxy in front of the server (README, TLS and reverse proxies).');
    }
    if (route.method !== 'GET' && request.headers[csrfHeader] !== '1') {
      throw new HttpError(403, 'csrf', `Requests that change data must include the ${csrfHeader}: 1 header.`);
    }
    if (route.auth !== 'admin') return;
    const token = request.cookies[adminSessionCookie];
    request.admin = auth.session(token);
    if (request.admin) return;
    if (token) reply.header('set-cookie', clearedCookie(secureCookie(context, request)));
    throw new HttpError(401, 'unauthorized', 'Admin sign-in is required.');
  });

  // SEC-7: per-route limits only, keyed by request.ip (which honours server.trustProxy).
  app.register(fastifyRateLimit, {
    global: false,
    addHeadersOnExceeding: { 'x-ratelimit-limit': false, 'x-ratelimit-remaining': false, 'x-ratelimit-reset': false },
    addHeaders: { 'x-ratelimit-limit': false, 'x-ratelimit-remaining': false, 'x-ratelimit-reset': false, 'retry-after': true },
    errorResponseBuilder: (_request, rate) => new RateLimitedError(Math.max(1, Math.ceil(rate.ttl / 1000))),
  });
  registerOpenApi(app, context.version);

  // SRV-5: the one error handler; errorReply() decides every error body.
  app.setErrorHandler((error, request, reply) => {
    const result = errorReply(error, {
      maxBodyBytes,
      // LOG-7, LOG-8: an unexpected error is a server log entry sharing the audit entry's request ID.
      onUnexpected: (unexpected) => request.log.error({ err: unexpected, source: 'http', route: request.routeOptions.url }, 'Unhandled API error'),
    });
    // LOG-14: a failure's audit entry names the error code and the failed fields, never their values.
    request.auditError = { error: result.body.error, ...(result.body.fields ? { fields: result.body.fields.map((field) => field.field) } : {}) };
    return sendError(reply, result);
  });
  // SRV-10: unknown routes get the error body, not an HTML page.
  app.setNotFoundHandler((_request, reply) => sendError(reply, errorReply(new HttpError(404, 'not_found', 'Route not found.'), { maxBodyBytes })));

  // Routes are added after @fastify/swagger, so every one of them is in the document (API-11).
  app.register(async (routes) => {
    routes.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger());
    for (const route of apiRoutes) registerRoute(routes, context, route);
    if (options.staticDir && existsSync(join(options.staticDir, 'index.html'))) registerStatic(routes, options.staticDir);
  });
  return app;
}

/** Registers one route table entry with its OpenAPI metadata, schemas and data-write barrier. */
function registerRoute(app: FastifyInstance, context: AppContext, route: RouteDefinition) {
  if (route.auth === 'admin' && !route.url.startsWith('/api/admin/')) throw new Error(`${route.url}: admin routes live under /api/admin/`);
  const limit = route.rateLimit ? rateLimitRule(context, route.rateLimit) : undefined;
  app.route({
    method: route.method,
    url: route.url,
    config: { apiRoute: route, ...(limit ? { rateLimit: limit } : {}) },
    schema: {
      operationId: route.operationId,
      tags: [route.tag],
      summary: route.summary,
      ...(route.description ? { description: route.description } : {}),
      security: [...routeSecurity(route)],
      ...(route.schema.params ? { params: route.schema.params } : {}),
      // API-10: a route without query parameters rejects any, like an undeclared body property.
      querystring: route.schema.querystring ?? Empty,
      ...(route.schema.body ? { body: route.schema.body } : {}),
      response: { ...route.schema.response, default: Type.Ref('ErrorBody', { description: 'Error (API-6).' }) },
    },
    // BAK-8: a writing route's handler runs as a data write; its response is computed before it is sent.
    handler: async (request: FastifyRequest, reply: FastifyReply) => (
      route.writesData ? withDataWrite(() => route.handler(context, request, reply)) : route.handler(context, request, reply)
    ),
  });
}

/** The `rateLimits.*` entry of a bucket, as `@fastify/rate-limit` takes it (SEC-7). */
function rateLimitRule(context: AppContext, name: RateLimitName) {
  const { max, windowMinutes } = context.config.rateLimits[name];
  return { max, timeWindow: windowMinutes * 60_000 };
}

function sendError(reply: FastifyReply, result: ErrorReply) {
  return reply.code(result.statusCode).headers(result.headers).type('application/json; charset=utf-8').send(result.body);
}

/** Serves `dist/` (SRV-9): the two entries, hashed assets with long caching, everything else `no-store`. */
function registerStatic(app: FastifyInstance, staticDir: string) {
  const root = resolve(staticDir);
  const assets = join(root, 'assets');
  app.register(fastifyStatic, {
    root: assets,
    prefix: '/assets/',
    index: false,
    // The plugin's own Cache-Control would replace the SEC-3 headers on the entry pages.
    cacheControl: false,
    // Hashed build files never change (SRV-9); the entry pages, also sent by this
    // plugin, keep the SEC-3 headers the onRequest hook set.
    setHeaders: (reply, path) => {
      if (!path.startsWith(`${assets}${sep}`)) return;
      reply.removeHeader('pragma');
      reply.removeHeader('expires');
      reply.header('cache-control', 'public, max-age=31536000, immutable');
    },
  });
  const page = (file: string, extra: Record<string, string> = {}) => async (_request: FastifyRequest, reply: FastifyReply) => (
    reply.headers(extra).sendFile(file, root)
  );
  const hidden = { schema: { hide: true } };
  app.get('/', hidden, page('index.html'));
  app.get('/admin', hidden, page('admin.html', { 'x-robots-tag': 'noindex, nofollow' }));
  app.get('/admin/', hidden, async (_request, reply) => reply.redirect('/admin', 301));
  // The files Vite copies from public/ (the logo, fonts and their licences, UI-15) at their own paths, never the entry pages.
  for (const file of publicFiles(root, assets)) app.get(`/${file}`, hidden, page(file));
}

/** Every file under `root` except the entry pages and the hashed build output, as URL paths. */
function publicFiles(root: string, assets: string) {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (path !== assets) walk(path);
      } else if (directory !== root || !entry.name.endsWith('.html')) {
        files.push(relative(root, path).split(sep).join('/'));
      }
    }
  };
  walk(root);
  return files;
}
