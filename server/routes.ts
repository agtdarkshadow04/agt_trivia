import type { TSchema } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PublicSettings } from '../src/lib/api.js';
import { settingValues, type AppContext } from './context.js';
import { readSettings } from './repository/settings.js';
import * as S from './schemas.js';
import { AdminAuthService, clearedCookie, secureCookie, sessionCookie, type AdminSession } from './session.js';
import { currentSettings, updateSettings } from './settings.js';

/**
 * The route table: every `/api/` route with its auth mode, data-write
 * declaration (BAK-8), OpenAPI metadata (API-11) and TypeBox schemas
 * (API-10). `buildApp()` registers each entry; tests iterate the table.
 */

/**
 * - `none`: no credentials are checked (public reads).
 * - `csrf`: no session, but the CSRF header (first-run setup and Admin sign-in, SEC-5).
 * - `admin`: the Admin session cookie, and the CSRF header on every non-GET request (AUTH-9, SEC-5).
 *   Admin routes, and only they, live under `/api/admin/`.
 * The member mode arrives with member accounts (#17).
 */
export type RouteAuth = 'none' | 'csrf' | 'admin';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** One OpenAPI tag per route: `public`, `auth`, `admin`, or a resource name (API-11). */
export type RouteTag = 'public' | 'auth' | 'admin';
/** Rate-limit buckets (SEC-7), each counted separately per route and client address; `rateLimits.*` in config.yaml. */
export type RateLimitName = 'login' | 'setup';

export interface RouteSchemas {
  params?: TSchema;
  querystring?: TSchema;
  body?: TSchema;
  /** Success responses by status code; `buildApp()` adds `default: ErrorBody`. */
  response: Record<number, TSchema>;
}

export interface RouteDefinition {
  method: HttpMethod;
  /** Fastify syntax (`/api/categories/:id`). */
  url: string;
  auth: RouteAuth;
  /** True when the route can change the main database (BAK-8); session rows alone do not count. */
  writesData: boolean;
  /** GET routes whose reads are audited, such as downloads and exports (LOG-11, #12). */
  audit?: boolean;
  /** Credential-checking routes are rate limited (SEC-7). */
  rateLimit?: RateLimitName;
  /** Unique camelCase verb + noun (API-11); also the audit `action` (LOG-10). */
  operationId: string;
  tag: RouteTag;
  /** One English sentence. */
  summary: string;
  description?: string;
  schema: RouteSchemas;
  /** Returns the response body; throw `HttpError` for failures. Set a status with `reply.code()`. */
  handler: (context: AppContext, request: FastifyRequest, reply: FastifyReply) => unknown;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in Admin's username, set by the authentication hook on `admin` routes. */
    admin: string | null;
  }
}

/** CFG-10: the settings the player UI needs. */
export function publicSettings(context: AppContext): PublicSettings {
  const values = settingValues(context.config, readSettings(context.db));
  return {
    siteTitle: values['site.title'],
    supportUrl: values['site.supportUrl'],
    quizShortLength: values['quiz.shortLength'],
    quizLongLength: values['quiz.longLength'],
  };
}

/** The server log for the auth service: `request.log` with `source: auth` (LOG-7). */
function authLog(request: FastifyRequest) {
  return {
    error: (message: string) => request.log.error({ source: 'auth' }, message),
    info: (message: string) => request.log.info({ source: 'auth' }, message),
  };
}

function startSession(context: AppContext, request: FastifyRequest, reply: FastifyReply, session: AdminSession) {
  reply.header('set-cookie', sessionCookie(session.token, session.expiresAt, secureCookie(context, request)));
  return { username: session.username };
}

function adminSession(context: AppContext, username: string) {
  return { username, version: context.version, setupPasswordStillSet: context.setupPassword !== null };
}

export const apiRoutes: readonly RouteDefinition[] = [
  {
    method: 'GET',
    url: '/api/health',
    auth: 'none',
    writesData: false,
    operationId: 'getHealth',
    tag: 'public',
    summary: 'Check that the server and its database answer.',
    description: 'Runs a trivial database query (SRV-11). Used by the Docker healthcheck; not rate limited.',
    schema: { response: { 200: S.Health } },
    handler: (context) => {
      context.db.ping();
      return { status: 'ok' };
    },
  },
  {
    method: 'GET',
    url: '/api/settings/public',
    auth: 'none',
    writesData: false,
    operationId: 'getPublicSettings',
    tag: 'public',
    summary: 'Read the settings the player UI needs.',
    schema: { response: { 200: S.PublicSettings } },
    handler: (context) => publicSettings(context),
  },
  {
    method: 'GET',
    url: '/api/setup/status',
    auth: 'none',
    writesData: false,
    operationId: 'getSetupStatus',
    tag: 'auth',
    summary: 'Read whether the Admin account exists and whether first-run setup is possible.',
    schema: { response: { 200: S.SetupStatus } },
    handler: (context) => new AdminAuthService(context).setupStatus(),
  },
  {
    method: 'POST',
    url: '/api/setup',
    auth: 'csrf',
    writesData: true,
    rateLimit: 'setup',
    operationId: 'createAdmin',
    tag: 'auth',
    summary: 'Create the Admin account with the setup password and sign it in.',
    description: 'Needs AGT_TRIVIA_SETUP_PASSWORD. Answers 410 setup_complete once the Admin exists, even while the variable is still set (AUTH-5).',
    schema: { body: S.SetupRequest, response: { 201: S.AdminIdentity } },
    handler: async (context, request, reply) => {
      const session = await new AdminAuthService(context).setup(request.body as { setupPassword: string; username: string; password: string }, authLog(request));
      reply.code(201);
      return startSession(context, request, reply, session);
    },
  },
  {
    method: 'POST',
    url: '/api/admin/login',
    auth: 'csrf',
    writesData: false,
    rateLimit: 'login',
    operationId: 'createAdminSession',
    tag: 'auth',
    summary: 'Sign the Admin in and set the session cookie.',
    schema: { body: S.Credentials, response: { 200: S.AdminIdentity } },
    handler: async (context, request, reply) => {
      const { username, password } = request.body as { username: string; password: string };
      return startSession(context, request, reply, await new AdminAuthService(context).login(username, password, authLog(request)));
    },
  },
  {
    method: 'POST',
    url: '/api/admin/logout',
    auth: 'admin',
    writesData: false,
    operationId: 'deleteAdminSession',
    tag: 'auth',
    summary: 'Sign the Admin out and clear the session cookie.',
    schema: { response: { 204: S.NoContent } },
    handler: (context, request, reply) => {
      new AdminAuthService(context).logout(request.cookies.agt_trivia_session);
      reply.header('set-cookie', clearedCookie(secureCookie(context, request))).code(204);
      return null;
    },
  },
  {
    method: 'GET',
    url: '/api/admin/session',
    auth: 'admin',
    writesData: false,
    operationId: 'getAdminSession',
    tag: 'auth',
    summary: 'Read the signed-in Admin, the app version and whether the setup password is still set.',
    schema: { response: { 200: S.AdminSession } },
    handler: (context, request) => adminSession(context, request.admin!),
  },
  {
    method: 'POST',
    url: '/api/admin/password',
    auth: 'admin',
    writesData: true,
    rateLimit: 'login',
    operationId: 'changeAdminPassword',
    tag: 'auth',
    summary: 'Change the Admin password, ending every other session.',
    description: 'Needs the current password. Ends every session and starts a new one for the caller (AUTH-4).',
    schema: { body: S.PasswordChange, response: { 200: S.AdminIdentity } },
    handler: async (context, request, reply) => {
      const { currentPassword, password } = request.body as { currentPassword: string; password: string };
      return startSession(context, request, reply, await new AdminAuthService(context).changePassword(currentPassword, password, authLog(request)));
    },
  },
  {
    method: 'GET',
    url: '/api/admin/settings',
    auth: 'admin',
    writesData: false,
    operationId: 'listSettings',
    tag: 'admin',
    summary: 'List every dashboard setting with its effective value and where it comes from.',
    schema: { response: { 200: S.SettingsList } },
    handler: (context) => ({ settings: currentSettings(context) }),
  },
  {
    method: 'PUT',
    url: '/api/admin/settings',
    auth: 'admin',
    writesData: true,
    operationId: 'updateSettings',
    tag: 'admin',
    summary: 'Change dashboard settings; null resets a setting to its default.',
    description: 'Rejects the whole request when a key is unknown (400 unknown_setting), set in config.yaml (409 defined_in_config) or invalid (400 invalid_setting) (CFG-8).',
    schema: { body: S.SettingsUpdate, response: { 200: S.SettingsResult } },
    handler: (context, request) => {
      const { settings } = updateSettings(context, (request.body as { values: Record<string, unknown> }).values);
      return { settings, notices: [] };
    },
  },
];
