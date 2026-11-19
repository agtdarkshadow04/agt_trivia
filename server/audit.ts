import type { FastifyReply, FastifyRequest } from 'fastify';
import type { LogStore } from './logs.js';
import type { ActorType, AuditOutcome } from './repository/logs.js';

/**
 * The audit log (LOG-10..LOG-14). One `onResponse` hook writes every entry, so
 * no route can be forgotten. Handlers only add the target and a summary of
 * the change through `request.audit`.
 */

/** What a handler adds to its request's audit entry. Never secrets or bulk content (LOG-14). */
export interface AuditInfo {
  /** Who acted, when the session does not say (a sign-in or setup that just succeeded). */
  actorType?: ActorType;
  actor?: string | null;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by handlers; the audit hook adds everything else. */
    audit: AuditInfo | null;
    /** The error code and failed field names (never their values) of an error response, set by the error handler. */
    auditError: { error: string; fields?: string[] } | null;
  }
}

/** LOG-10: the outcome of a status code. */
export function auditOutcome(statusCode: number): AuditOutcome {
  if (statusCode < 400) return 'success';
  if (statusCode === 401 || statusCode === 403) return 'denied';
  if (statusCode === 429) return 'rate_limited';
  return 'failure';
}

/**
 * LOG-11: audits every request to a non-GET route, GET routes marked
 * `audit: true`, every 401/403 from an admin route and every 429. Ordinary
 * reads and unknown routes are not audited. A failure to write never fails the
 * request (LOG-3).
 */
export function auditHook(logs: Pick<LogStore, 'audit' | 'ipHash'>) {
  return async function audit(request: FastifyRequest, reply: FastifyReply) {
    const route = request.routeOptions.config.apiRoute;
    if (!route) return;
    const statusCode = reply.statusCode;
    const audited = route.method !== 'GET'
      || route.audit === true
      || (route.url.startsWith('/api/admin/') && (statusCode === 401 || statusCode === 403))
      || statusCode === 429;
    if (!audited) return;
    const info = request.audit ?? {};
    logs.audit({
      actorType: info.actorType ?? (request.admin ? 'admin' : 'anonymous'),
      actor: info.actor !== undefined ? info.actor : request.admin ?? null,
      ipHash: logs.ipHash(request.ip),
      // LOG-13: informational only; it never affects authorization.
      client: request.headers['x-agt-client'] === 'web' ? 'web' : 'api',
      action: route.operationId,
      method: route.method,
      route: request.routeOptions.url ?? route.url,
      targetType: info.targetType ?? null,
      targetId: info.targetId ?? null,
      outcome: auditOutcome(statusCode),
      statusCode,
      requestId: request.id,
      details: { ...info.details, ...(request.auditError ?? {}) },
    });
  };
}
