import type { FastifyRequest } from 'fastify';
import { publicRankedBoard, RankedService, rankedCategories, setRankedCategories } from './ranked.js';
import type { RouteDefinition } from './routes.js';
import * as S from './schemas.js';

/**
 * Ranked mode (#66): a member's runs (member cookie, `x-agt-request: 1` on
 * every write), the public board, and the Admin's choice of categories. Audit
 * entries name the run and the question's position, never the answers chosen
 * (LOG-9, LOG-14).
 */

function service(context: Parameters<RouteDefinition['handler']>[0], request: FastifyRequest) {
  return new RankedService(context, request.member!);
}

const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;

export const rankedRoutes: readonly RouteDefinition[] = [
  {
    method: 'POST',
    url: '/api/member/ranked/runs',
    auth: 'member',
    writesData: true,
    operationId: 'startRankedRun',
    tag: 'ranked',
    summary: 'Start a ranked run, forfeiting the member\'s open one.',
    description: 'Any member, while `ranked.enabled` is on (`403 ranked_closed`). Draws `ranked.questionsPerRun` questions from the included categories, spread across them, leaving out those the member was shown within `ranked.cooldownDays` (`409 ranked_unavailable` with `reason` `too_few_questions` or `cooldown`). An open run is forfeited and counts.',
    schema: { response: { 201: S.RankedRunCreated } },
    handler: (context, request, reply) => {
      const run = service(context, request).start();
      request.audit = { targetType: 'ranked_run', targetId: run.id, details: { questions: run.questionCount } };
      reply.code(201);
      return { run, notices: [] };
    },
  },
  {
    method: 'POST',
    url: '/api/member/ranked/runs/:id/next',
    auth: 'member',
    writesData: true,
    operationId: 'nextRankedQuestion',
    tag: 'ranked',
    summary: 'Show the current question of a ranked run, starting its time.',
    description: 'Shows the next question and records when (a write), or the same question again with its original deadline. Questions whose time ran out expire; after the last one the run finishes and `question` is null. `409 run_not_active` for an ended run.',
    schema: { params: S.RankedRunIdParams, response: { 200: S.RankedStep } },
    handler: (context, request) => {
      const step = service(context, request).next(idOf(request));
      request.audit = { targetType: 'ranked_run', targetId: step.run.id, details: { position: step.question?.position ?? null, status: step.run.status } };
      return step;
    },
  },
  {
    method: 'POST',
    url: '/api/member/ranked/runs/:id/answers',
    auth: 'member',
    writesData: true,
    operationId: 'answerRankedQuestion',
    tag: 'ranked',
    summary: 'Answer the question being shown; the first answer is final.',
    description: 'Only the question being shown (`409 question_not_current`). The reply says whether the answer came in time, never whether it was right. The last answer finishes the run, and only then does `run.totals` appear.',
    schema: { params: S.RankedRunIdParams, body: S.RankedAnswerBody, response: { 200: S.RankedAnswerResult } },
    handler: (context, request) => {
      const { position, choiceIds } = request.body as { position: number; choiceIds: string[] };
      const result = service(context, request).answer(idOf(request), position, choiceIds);
      request.audit = { targetType: 'ranked_run', targetId: result.run.id, details: { position, late: result.late, status: result.run.status } };
      return result;
    },
  },
  {
    method: 'GET',
    url: '/api/member/ranked/runs/:id',
    auth: 'member',
    writesData: false,
    operationId: 'getRankedRun',
    tag: 'ranked',
    summary: 'Read one of the member\'s ranked runs: its progress, or its totals once ended.',
    schema: { params: S.RankedRunIdParams, response: { 200: S.RankedRun } },
    handler: (context, request) => service(context, request).get(idOf(request)),
  },
  {
    method: 'GET',
    url: '/api/member/ranked/me',
    auth: 'member',
    writesData: false,
    operationId: 'getMyRanked',
    tag: 'ranked',
    summary: 'Read the member\'s own rating, rank, open run and latest ranked runs.',
    schema: { response: { 200: S.MyRanked } },
    handler: (context, request) => service(context, request).mine(),
  },
  {
    method: 'GET',
    url: '/api/ranked/leaderboard',
    auth: 'none',
    writesData: false,
    operationId: 'getRankedLeaderboard',
    tag: 'public',
    summary: 'Read the ranked board of the members who chose to appear on leaderboards.',
    description: 'Only while `ranked.enabled` is on (`403 ranked_closed` otherwise). Display names only.',
    schema: { response: { 200: S.RankedLeaderboard } },
    handler: (context) => publicRankedBoard(context),
  },
  {
    method: 'GET',
    url: '/api/admin/ranked/categories',
    auth: 'admin',
    writesData: false,
    operationId: 'listRankedCategories',
    tag: 'ranked',
    summary: 'List every category with whether ranked runs draw from it.',
    schema: { response: { 200: S.RankedCategoryList } },
    handler: (context) => rankedCategories(context),
  },
  {
    method: 'PUT',
    url: '/api/admin/ranked/categories',
    auth: 'admin',
    writesData: true,
    operationId: 'replaceRankedCategories',
    tag: 'ranked',
    summary: 'Include categories in ranked runs or leave them out.',
    description: 'Only the categories listed change. A category is included until the Admin leaves it out; new categories are included.',
    schema: { body: S.RankedCategoriesBody, response: { 200: S.RankedCategoriesResult } },
    handler: (context, request) => {
      const result = setRankedCategories(context, (request.body as { categories: { id: string; ranked: boolean }[] }).categories);
      request.audit = { targetType: 'ranked_categories', details: { included: result.changed.filter((change) => change.ranked).map((change) => change.id), excluded: result.changed.filter((change) => !change.ranked).map((change) => change.id) } };
      return { categories: result.categories, notices: [] };
    },
  },
];
