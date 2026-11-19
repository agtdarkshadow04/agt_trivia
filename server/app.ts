import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import type { AppContext } from './context.js';
import { noStoreHeaders, securityHeaders } from './headers.js';

export interface BuildAppOptions {
  /** A pino logger, or `false` for none (tests). */
  logger?: FastifyServerOptions['loggerInstance'] | false;
  /** The built client (`dist/`); without it only the API is served. */
  staticDir?: string;
}

/** The API-6 error body. */
interface ErrorBody {
  error: string;
  message: string;
}

/**
 * The Fastify app, fully configured but not listening (SRV-2), so tests can
 * use `inject()`.
 */
export function buildApp(_context: AppContext, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    ...(options.logger ? { loggerInstance: options.logger } : { logger: false }),
    // LOG-6: access logs are user activity, which the audit log covers.
    logController: new LogController({ disableRequestLogging: true }),
    // AUTH-5: JSON bodies are at most 2 MiB.
    bodyLimit: 2 * 1024 * 1024,
  });

  // SEC-1..SEC-3 on every response, errors and static files included. Hashed assets override the cache headers.
  app.addHook('onRequest', async (_request, reply) => {
    reply.headers({ ...securityHeaders, ...noStoreHeaders });
  });

  // SRV-5: unexpected errors are logged and never sent with their message or stack.
  app.setErrorHandler((error, request, reply) => {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error, source: 'http', route: request.routeOptions.url }, 'Unhandled API error');
      return sendError(reply, 500, { error: 'internal', message: 'An unexpected server error occurred.' });
    }
    return sendError(reply, statusCode, { error: 'invalid_request', message: 'The request is invalid.' });
  });
  // SRV-10: unknown routes get the error body, not an HTML page.
  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, { error: 'not_found', message: 'Route not found.' }));

  // SRV-11. The trivial database query arrives with the database (#10).
  app.get('/api/health', async () => ({ status: 'ok' }));

  if (options.staticDir && existsSync(join(options.staticDir, 'index.html'))) registerStatic(app, options.staticDir);
  return app;
}

function sendError(reply: FastifyReply, statusCode: number, body: ErrorBody) {
  return reply.code(statusCode).type('application/json; charset=utf-8').send(body);
}

/**
 * Serves `dist/` (SRV-9): the two entries, hashed assets with long caching, everything else `no-store`.
 * These routes get `schema: { hide: true }` when `@fastify/swagger` arrives (#10).
 */
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
  app.get('/', page('index.html'));
  app.get('/admin', page('admin.html', { 'x-robots-tag': 'noindex, nofollow' }));
  app.get('/admin/', async (_request, reply) => reply.redirect('/admin', 301));
  // The files Vite copies from public/ (the logo, fonts and their licences, UI-15) at their own paths, never the entry pages.
  for (const file of publicFiles(root, assets)) app.get(`/${file}`, page(file));
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
