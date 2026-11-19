import type { TSchema } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PublicSettings } from '../src/lib/api.js';
import { settingValues, type AppContext } from './context.js';
import { readSettings } from './repository/settings.js';
import * as S from './schemas.js';

/**
 * The route table: every `/api/` route with its auth mode, data-write
 * declaration (BAK-8), OpenAPI metadata (API-11) and TypeBox schemas
 * (API-10). `buildApp()` registers each entry; tests iterate the table.
 */

/**
 * - `none`: no credentials are checked (public reads).
 * The Admin (`admin`) and member (`member`) modes arrive with their sessions (#11, #17).
 */
export type RouteAuth = 'none';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** One OpenAPI tag per route: `public`, `auth`, `admin`, or a resource name (API-11). */
export type RouteTag = 'public';

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
];
