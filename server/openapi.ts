import fastifySwagger from '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import type { RouteDefinition } from './routes.js';
import { ErrorBodySchema, FieldErrorSchema, RestoreUploadDocument } from './schemas.js';
import { adminSessionCookie, memberSessionCookie } from './session.js';

/** What each kind of route really requires (API-11, AUTH-9, SEC-5); every route uses one of these. */
export const SECURITY = {
  /** Public reads and anonymous writes. */
  none: [],
  /** First-run setup and Admin sign-in: the CSRF header, no session. */
  csrfOnly: [{ csrfHeader: [] }],
  /** Admin reads. */
  adminRead: [{ sessionCookie: [] }],
  /** Admin writes, logout included. */
  adminWrite: [{ sessionCookie: [], csrfHeader: [] }],
  /** Member reads (#17, AUTH-1 deviation). */
  memberRead: [{ memberSessionCookie: [] }],
  /** Member writes, logout included. */
  memberWrite: [{ memberSessionCookie: [], csrfHeader: [] }],
} as const;

/** The `security` value of a route, from its auth mode. */
export function routeSecurity(route: Pick<RouteDefinition, 'auth' | 'method'>) {
  switch (route.auth) {
    case 'none':
      return SECURITY.none;
    case 'csrf':
      return SECURITY.csrfOnly;
    case 'admin':
      return route.method === 'GET' ? SECURITY.adminRead : SECURITY.adminWrite;
    case 'member':
      return route.method === 'GET' ? SECURITY.memberRead : SECURITY.memberWrite;
  }
}

/**
 * Registers `@fastify/swagger` (API-11). Call it before any route is added,
 * so every route lands in the document served at `GET /api/openapi.json`.
 */
export function registerOpenApi(app: FastifyInstance, version: string) {
  app.addSchema(FieldErrorSchema);
  app.addSchema(ErrorBodySchema);
  return app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'AGT Galactic Trivia API',
        version,
        description: 'The REST API of AGT Galactic Trivia. Errors use the `ErrorBody` schema (API-6); `docs/API.md` explains the conventions.',
      },
      components: {
        securitySchemes: {
          sessionCookie: { type: 'apiKey', in: 'cookie', name: adminSessionCookie, description: 'The Admin session.' },
          memberSessionCookie: { type: 'apiKey', in: 'cookie', name: memberSessionCookie, description: 'A member session; never accepted on Admin routes, and the Admin session never on member routes.' },
          csrfHeader: { type: 'apiKey', in: 'header', name: 'x-agt-request', description: 'Must be "1".' },
        },
      },
      tags: [
        { name: 'public', description: 'Public reads that need no sign-in.' },
        { name: 'auth', description: 'First-run setup, Admin and member sign-in, the sessions and the passwords.' },
        { name: 'admin', description: 'The admin dashboard.' },
        { name: 'members', description: "The Admin's management of member accounts (#17)." },
        { name: 'questions', description: 'Question authoring and review by Editors and Moderators (#19).' },
      ],
    },
    // A multipart route validates no parsed body; the document shows its form fields (BAK-1).
    transform: ({ schema, url, route }) => {
      const apiRoute = (route.config as { apiRoute?: RouteDefinition } | undefined)?.apiRoute;
      if (!apiRoute?.multipart || !schema) return { schema, url };
      return { schema: { ...schema, body: RestoreUploadDocument } as typeof schema, url };
    },
    refResolver: { buildLocalReference: (json, _baseUri, _fragment, index) => (typeof json.$id === 'string' ? json.$id : `def-${index}`) },
  });
}
