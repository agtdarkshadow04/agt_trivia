import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import { HttpError } from './http.js';
import { auditColumns, decodeLogCursor, encodeLogCursor, exportFileName, exportStream, serverColumns, type ExportFormat } from './logs.js';
import type { AuditFilters, ServerFilters } from './repository/logs.js';
import type { RouteDefinition } from './routes.js';
import * as S from './schemas.js';

/** The Server log and Audit log tabs' routes (LOG-18). There is no route that edits or deletes audit entries. */

type Query = Record<string, string | undefined>;

/** `from`/`to` as stored (ISO 8601 UTC with milliseconds), so text comparison orders them. */
function instant(value: string | undefined) {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function pageOf(query: Query) {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (limit > 200) throw new HttpError(400, 'invalid_request', 'limit must be between 1 and 200.');
  let before: number | null = null;
  if (query.cursor !== undefined) {
    before = decodeLogCursor(query.cursor);
    if (before === null) throw new HttpError(400, 'invalid_request', 'The cursor is not valid.');
  }
  return { limit, before };
}

function serverFilters(query: Query): ServerFilters {
  return { level: query.level as ServerFilters['level'], source: query.source, from: instant(query.from), to: instant(query.to), q: query.q };
}

function auditFilters(query: Query): AuditFilters {
  return {
    actorType: query.actorType as AuditFilters['actorType'],
    action: query.action,
    outcome: query.outcome as AuditFilters['outcome'],
    targetType: query.targetType,
    targetId: query.targetId,
    from: instant(query.from),
    to: instant(query.to),
    q: query.q,
  };
}

/** One page, newest first, with the cursor after its last entry (API-8). Fetches one more to know whether a next page exists. */
function listed<Entry extends { seq?: number }>(rows: Entry[], limit: number) {
  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit && items.length ? encodeLogCursor(items.at(-1)!.seq!) : null;
  return { items: items.map(({ seq: _seq, ...entry }) => entry), nextCursor };
}

function sendExport(context: AppContext, request: FastifyRequest, reply: FastifyReply, log: 'server' | 'audit') {
  const query = request.query as Query;
  const format = query.format as ExportFormat;
  const stream = log === 'server'
    ? exportStream((before, limit) => context.logs.listServer(serverFilters(query), before, limit), format, serverColumns)
    : exportStream((before, limit) => context.logs.listAudit(auditFilters(query), before, limit), format, auditColumns);
  const { format: _format, ...filters } = query;
  // LOG-14: the export's format and filters, never its content.
  request.audit = { details: { format, filters } };
  return reply
    .header('content-type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8')
    .header('content-disposition', `attachment; filename="${exportFileName(log, format, new Date())}"`)
    .send(stream);
}

export const logRoutes: readonly RouteDefinition[] = [
  {
    method: 'GET',
    url: '/api/admin/logs/server',
    auth: 'admin',
    writesData: false,
    operationId: 'listServerLog',
    tag: 'admin',
    summary: 'List server log entries, newest first, with filters.',
    schema: { querystring: S.ServerLogQuery, response: { 200: S.ServerLogPage } },
    handler: (context, request) => {
      const query = request.query as Query;
      const { limit, before } = pageOf(query);
      return listed(context.logs.listServer(serverFilters(query), before, limit + 1), limit);
    },
  },
  {
    method: 'GET',
    url: '/api/admin/logs/server/export',
    auth: 'admin',
    writesData: false,
    audit: true,
    operationId: 'exportServerLog',
    tag: 'admin',
    summary: 'Download the server log entries matching the filters as JSON Lines or CSV.',
    schema: { querystring: S.ServerLogExportQuery, response: { 200: S.LogExport } },
    handler: (context, request, reply) => sendExport(context, request, reply, 'server'),
  },
  {
    method: 'GET',
    url: '/api/admin/logs/server/summary',
    auth: 'admin',
    writesData: false,
    operationId: 'getServerLogSummary',
    tag: 'admin',
    summary: 'Count the warnings and errors since the server log was last opened.',
    schema: { response: { 200: S.ServerLogSummary } },
    handler: (context) => context.logs.summary(),
  },
  {
    method: 'POST',
    url: '/api/admin/logs/server/seen',
    auth: 'admin',
    writesData: false,
    operationId: 'markServerLogSeen',
    tag: 'admin',
    summary: 'Mark every server log entry so far as seen.',
    schema: { response: { 204: S.NoContent } },
    handler: (context, _request, reply) => {
      context.logs.markSeen();
      reply.code(204);
      return null;
    },
  },
  {
    method: 'DELETE',
    url: '/api/admin/logs/server',
    auth: 'admin',
    writesData: false,
    operationId: 'clearServerLog',
    tag: 'admin',
    summary: 'Delete every server log entry; the audit log is not affected.',
    schema: { response: { 204: S.NoContent } },
    handler: (context, request, reply) => {
      request.audit = { details: { deleted: context.logs.clearServer() } };
      reply.code(204);
      return null;
    },
  },
  {
    method: 'GET',
    url: '/api/admin/logs/audit',
    auth: 'admin',
    writesData: false,
    operationId: 'listAuditLog',
    tag: 'admin',
    summary: 'List audit log entries, newest first, with filters.',
    schema: { querystring: S.AuditLogQuery, response: { 200: S.AuditLogPage } },
    handler: (context, request) => {
      const query = request.query as Query;
      const { limit, before } = pageOf(query);
      return listed(context.logs.listAudit(auditFilters(query), before, limit + 1), limit);
    },
  },
  {
    method: 'GET',
    url: '/api/admin/logs/audit/export',
    auth: 'admin',
    writesData: false,
    audit: true,
    operationId: 'exportAuditLog',
    tag: 'admin',
    summary: 'Download the audit log entries matching the filters as JSON Lines or CSV.',
    schema: { querystring: S.AuditLogExportQuery, response: { 200: S.LogExport } },
    handler: (context, request, reply) => sendExport(context, request, reply, 'audit'),
  },
];
