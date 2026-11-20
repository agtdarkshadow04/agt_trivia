import { HttpError } from './http.js';
import { ResultService, type ResultSubmission } from './results.js';
import type { RouteDefinition } from './routes.js';
import * as S from './schemas.js';

/**
 * Member score history (#21): every signed-in member, any role, keeps their
 * own results, and nobody else sees them. Audit summaries name the category,
 * length and score, never the answers (LOG-14).
 */

/** `?limit=` as a number from 1 to 200 (API-8). */
function pageLimit(limit: string | undefined) {
  if (limit === undefined) return undefined;
  const value = Number(limit);
  if (!Number.isInteger(value) || value < 1 || value > 200) throw new HttpError(400, 'invalid_request', 'limit must be 1 to 200.');
  return value;
}

export const resultRoutes: readonly RouteDefinition[] = [
  {
    method: 'POST',
    url: '/api/member/results',
    auth: 'member',
    writesData: true,
    operationId: 'createResult',
    tag: 'results',
    summary: "Grade a finished quiz and add it to the member's history.",
    description: 'The server grades the answers against the category\'s approved questions; answers to questions no longer approved are left out and listed in `skippedQuestionIds` (`409 conflict` when none is left). With `attemptToken` (#45) the answers must be exactly the drawn quiz\'s questions (`400 attempt_invalid` otherwise), and sending the same attempt again returns the saved result with `200`. Sending a result without `attemptToken` is deprecated: 3.0.0 will refuse it.',
    schema: { body: S.ResultCreateBody, response: { 200: S.ResultCreated, 201: S.ResultCreated } },
    handler: (context, request, reply) => {
      const { result, skippedQuestionIds, repeated } = new ResultService(context, request.member!).submit(request.body as ResultSubmission);
      request.audit = {
        targetType: 'result',
        targetId: result.id,
        details: { categoryId: result.categoryId, length: result.length, score: result.score, total: result.total, attempt: (request.body as ResultSubmission).attemptToken === undefined ? 'none' : repeated ? 'repeated' : 'verified' },
      };
      reply.code(repeated ? 200 : 201);
      return { result, skippedQuestionIds, notices: [] };
    },
  },
  {
    method: 'GET',
    url: '/api/member/results',
    auth: 'member',
    writesData: false,
    operationId: 'listResults',
    tag: 'results',
    summary: "List the member's own results, newest first, one page at a time.",
    schema: { querystring: S.ResultListQuery, response: { 200: S.ResultPage } },
    handler: (context, request) => {
      const query = request.query as { limit?: string; cursor?: string; categoryId?: string };
      return new ResultService(context, request.member!).list({ ...query, limit: pageLimit(query.limit) });
    },
  },
  {
    method: 'DELETE',
    url: '/api/member/results',
    auth: 'member',
    writesData: true,
    operationId: 'deleteResults',
    tag: 'results',
    summary: "Clear the member's own score history.",
    schema: { response: { 204: S.NoContent } },
    handler: (context, request, reply) => {
      const deleted = new ResultService(context, request.member!).clear();
      request.audit = { targetType: 'member', targetId: request.member!.id, details: { deleted } };
      reply.code(204);
      return null;
    },
  },
  {
    method: 'GET',
    url: '/api/member/stats',
    auth: 'member',
    writesData: false,
    operationId: 'getMemberStats',
    tag: 'results',
    summary: "The member's own plays, best and average percentage and last play, per category.",
    schema: { response: { 200: S.MemberStats } },
    handler: (context, request) => new ResultService(context, request.member!).stats(),
  },
];
