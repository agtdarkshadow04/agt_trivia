import type { FastifyRequest } from 'fastify';
import type { QuestionBody } from '../src/lib/api.js';
import type { QuestionStatus } from '../src/lib/validation.js';
import { HttpError } from './http.js';
import { QuestionService } from './questions.js';
import type { RouteDefinition } from './routes.js';
import * as S from './schemas.js';

/**
 * Question authoring and review (#19): member routes for Editors and
 * Moderators (`403 forbidden` for Players). Audit summaries name the question
 * by ID, status and changed field names, never its text (LOG-14).
 */

function service(context: Parameters<RouteDefinition['handler']>[0], request: FastifyRequest) {
  return new QuestionService(context, request.member!);
}

/** `?limit=` as a number from 1 to 200 (API-8). */
function pageLimit(limit: string | undefined) {
  if (limit === undefined) return undefined;
  const value = Number(limit);
  if (!Number.isInteger(value) || value < 1 || value > 200) throw new HttpError(400, 'invalid_request', 'limit must be 1 to 200.');
  return value;
}

const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;

/** A status change: `submit`, `approve` or `unpublish`, with only the version in the body. */
function statusRoute(verb: 'submit' | 'approve' | 'unpublish', operationId: string, summary: string, description: string): RouteDefinition {
  return {
    method: 'POST',
    url: `/api/member/questions/:id/${verb}`,
    auth: 'member',
    writesData: true,
    operationId,
    tag: 'questions',
    summary,
    description,
    schema: { params: S.QuestionIdParams, body: S.QuestionVersionBody, response: { 200: S.MemberQuestion } },
    handler: (context, request) => {
      const { version } = request.body as { version: number };
      const result = service(context, request)[verb](idOf(request), version);
      request.audit = { targetType: 'question', targetId: result.question.id, details: { from: result.from, status: result.question.status } };
      return result.question;
    },
  };
}

export const questionRoutes: readonly RouteDefinition[] = [
  {
    method: 'GET',
    url: '/api/member/questions',
    auth: 'member',
    writesData: false,
    operationId: 'listQuestions',
    tag: 'questions',
    summary: 'List questions, newest first, one page at a time.',
    description: 'Editors see only their own questions; Moderators see every question, or their own with `mine=true`. The review queue is `status=pending`.',
    schema: { querystring: S.QuestionListQuery, response: { 200: S.QuestionPage } },
    handler: (context, request) => {
      const query = request.query as { limit?: string; cursor?: string; status?: QuestionStatus; categoryId?: string; mine?: 'true' | 'false'; q?: string };
      return service(context, request).list({ ...query, limit: pageLimit(query.limit), mine: query.mine === 'true' });
    },
  },
  {
    method: 'GET',
    url: '/api/member/question-counts',
    auth: 'member',
    writesData: false,
    operationId: 'getQuestionCounts',
    tag: 'questions',
    summary: "Count the member's own questions by status, and for Moderators the review queue.",
    schema: { response: { 200: S.QuestionCounts } },
    handler: (context, request) => service(context, request).counts(),
  },
  {
    method: 'GET',
    url: '/api/member/questions/:id',
    auth: 'member',
    writesData: false,
    operationId: 'getQuestion',
    tag: 'questions',
    summary: 'Read one question.',
    schema: { params: S.QuestionIdParams, response: { 200: S.MemberQuestion } },
    handler: (context, request) => service(context, request).get(idOf(request)),
  },
  {
    method: 'POST',
    url: '/api/member/questions',
    auth: 'member',
    writesData: true,
    operationId: 'createQuestion',
    tag: 'questions',
    summary: 'Write a new question as a draft.',
    description: 'Editors and Moderators. The credit is the author\'s display name unless a Moderator sets another.',
    schema: { body: S.QuestionCreateBody, response: { 201: S.QuestionResult } },
    handler: (context, request, reply) => {
      const result = service(context, request).create(request.body as QuestionBody);
      request.audit = { targetType: 'question', targetId: result.question.id, details: { categoryId: result.question.categoryId, status: result.question.status } };
      reply.code(201);
      return result;
    },
  },
  {
    method: 'PUT',
    url: '/api/member/questions/:id',
    auth: 'member',
    writesData: true,
    operationId: 'replaceQuestion',
    tag: 'questions',
    summary: "Replace a question's category, text, answers and credit.",
    description: 'Editors change their own questions until they are approved; Moderators change any question, and an approved one stays approved. A changed rejected question is a draft again.',
    schema: { params: S.QuestionIdParams, body: S.QuestionReplaceBody, response: { 200: S.QuestionResult } },
    handler: (context, request) => {
      const { question, notices, changed } = service(context, request).replace(idOf(request), request.body as QuestionBody & { version: number });
      request.audit = { targetType: 'question', targetId: question.id, details: { changed, status: question.status } };
      return { question, notices };
    },
  },
  {
    method: 'DELETE',
    url: '/api/member/questions/:id',
    auth: 'member',
    writesData: true,
    operationId: 'deleteQuestion',
    tag: 'questions',
    summary: 'Delete a question and its answers.',
    description: 'Editors delete their own questions until they are approved; Moderators delete any question.',
    schema: { params: S.QuestionIdParams, querystring: S.QuestionDeleteQuery, response: { 204: S.NoContent } },
    handler: (context, request, reply) => {
      const version = Number((request.query as { version: string }).version);
      const question = service(context, request).delete(idOf(request), version);
      request.audit = { targetType: 'question', targetId: question.id, details: { status: question.status } };
      reply.code(204);
      return null;
    },
  },
  statusRoute('submit', 'submitQuestion', 'Submit a draft or rejected question for review.', 'Its author, or a Moderator. The status becomes `pending`.'),
  statusRoute('approve', 'approveQuestion', 'Approve a pending question, adding it to the public quiz.', 'Moderators only, their own questions included. The review note is cleared.'),
  {
    method: 'POST',
    url: '/api/member/questions/:id/reject',
    auth: 'member',
    writesData: true,
    operationId: 'rejectQuestion',
    tag: 'questions',
    summary: 'Reject a pending question with a review note for its author.',
    description: 'Moderators only. The author can change the question and submit it again.',
    schema: { params: S.QuestionIdParams, body: S.QuestionRejectBody, response: { 200: S.MemberQuestion } },
    handler: (context, request) => {
      const { version, reviewNote } = request.body as { version: number; reviewNote: string };
      const result = service(context, request).reject(idOf(request), version, reviewNote);
      // LOG-14: that a note was given, never its text.
      request.audit = { targetType: 'question', targetId: result.question.id, details: { from: result.from, status: result.question.status } };
      return result.question;
    },
  },
  statusRoute('unpublish', 'unpublishQuestion', 'Take an approved question out of the public quiz, back to a draft.', 'Moderators only.'),
];
