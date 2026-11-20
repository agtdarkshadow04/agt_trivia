import type { FastifyRequest } from 'fastify';
import type { ReportInput, ReportStatus } from '../src/lib/validation.js';
import { HttpError } from './http.js';
import { ReportService } from './reports.js';
import type { RouteDefinition } from './routes.js';
import * as S from './schemas.js';

/**
 * Question reports (#46): any signed-in member reports an approved question;
 * Moderators list and close reports (`403 forbidden` for everyone else).
 * Audit summaries name the question and the reason, never the notes (LOG-14).
 */

function service(context: Parameters<RouteDefinition['handler']>[0], request: FastifyRequest) {
  return new ReportService(context, request.member!);
}

/** `?limit=` as a number from 1 to 200 (API-8). */
function pageLimit(limit: string | undefined) {
  if (limit === undefined) return undefined;
  const value = Number(limit);
  if (!Number.isInteger(value) || value < 1 || value > 200) throw new HttpError(400, 'invalid_request', 'limit must be 1 to 200.');
  return value;
}

const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;

function closeRoute(verb: 'resolve' | 'dismiss', operationId: string, summary: string): RouteDefinition {
  return {
    method: 'POST',
    url: `/api/member/reports/:id/${verb}`,
    auth: 'member',
    writesData: true,
    operationId,
    tag: 'reports',
    summary,
    description: 'Moderators only, on an open report at the `version` that was read (`409 conflict` otherwise).',
    schema: { params: S.ReportIdParams, body: S.ReportCloseBody, response: { 200: S.QuestionReport } },
    handler: (context, request) => {
      const { version, resolutionNote } = request.body as { version: number; resolutionNote: string };
      const report = service(context, request).close(idOf(request), version, verb === 'resolve' ? 'resolved' : 'dismissed', resolutionNote);
      // LOG-14: that a note was given, never its text.
      request.audit = { targetType: 'report', targetId: report.id, details: { questionId: report.questionId, status: report.status, note: report.resolutionNote !== '' } };
      return report;
    },
  };
}

export const reportRoutes: readonly RouteDefinition[] = [
  {
    method: 'POST',
    url: '/api/member/questions/:id/reports',
    auth: 'member',
    writesData: true,
    operationId: 'reportQuestion',
    tag: 'reports',
    summary: 'Report a problem with an approved question.',
    description: 'Any signed-in member. At most one open report per member and question (`409 report_exists`); a question that is not approved answers 404.',
    schema: { params: S.QuestionIdParams, body: S.ReportCreateBody, response: { 201: S.QuestionReport } },
    handler: (context, request, reply) => {
      const report = service(context, request).create(idOf(request), request.body as ReportInput);
      request.audit = { targetType: 'report', targetId: report.id, details: { questionId: report.questionId, reason: report.reason, note: report.note !== '' } };
      reply.code(201);
      return report;
    },
  },
  {
    method: 'GET',
    url: '/api/member/reports',
    auth: 'member',
    writesData: false,
    operationId: 'listReports',
    tag: 'reports',
    summary: 'List question reports, oldest first, one page at a time.',
    description: 'Moderators only. `status` is `open` by default.',
    schema: { querystring: S.ReportListQuery, response: { 200: S.ReportPage } },
    handler: (context, request) => {
      const query = request.query as { status?: ReportStatus; limit?: string; cursor?: string };
      return service(context, request).list({ ...query, limit: pageLimit(query.limit) });
    },
  },
  closeRoute('resolve', 'resolveReport', 'Mark an open question report as resolved.'),
  closeRoute('dismiss', 'dismissReport', 'Dismiss an open question report.'),
];
