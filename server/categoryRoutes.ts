import type { CategoryBody } from '../src/lib/api.js';
import { fieldError } from '../src/lib/errors.js';
import { CategoryService } from './categories.js';
import type { RouteDefinition } from './routes.js';
import * as S from './schemas.js';

/**
 * Category management (#20): member routes for Moderators (`403 forbidden`
 * for everyone else). Audit summaries name the category by ID and short name
 * and list the changed field names (LOG-14).
 */

export const categoryRoutes: readonly RouteDefinition[] = [
  {
    method: 'GET',
    url: '/api/member/categories',
    auth: 'member',
    writesData: false,
    operationId: 'listManagedCategories',
    tag: 'categories',
    summary: 'List every category with its questions counted by status.',
    description: 'Moderators only.',
    schema: { response: { 200: S.ManagedCategoryList } },
    handler: (context, request) => new CategoryService(context, request.member!).list(),
  },
  {
    method: 'POST',
    url: '/api/member/categories',
    auth: 'member',
    writesData: true,
    operationId: 'createCategory',
    tag: 'categories',
    summary: 'Create a category.',
    description: 'Moderators only. Short names and names are unique ignoring case (`duplicate`).',
    schema: { body: S.CategoryCreateBody, response: { 201: S.CategoryResult } },
    handler: (context, request, reply) => {
      const category = new CategoryService(context, request.member!).create(request.body as CategoryBody);
      request.audit = { targetType: 'category', targetId: category.id, details: { shortName: category.shortName } };
      reply.code(201);
      return { category, notices: [] };
    },
  },
  {
    method: 'PUT',
    url: '/api/member/categories/:id',
    auth: 'member',
    writesData: true,
    operationId: 'replaceCategory',
    tag: 'categories',
    summary: "Replace a category's short name, name, description and priority.",
    description: 'Moderators only. A new short name breaks old `?category=` links.',
    schema: { params: S.CategoryIdParams, body: S.CategoryReplaceBody, response: { 200: S.CategoryResult } },
    handler: (context, request) => {
      const { version, ...body } = request.body as CategoryBody & { version: number };
      const { category, changed } = new CategoryService(context, request.member!).replace((request.params as { id: string }).id, version, body);
      request.audit = { targetType: 'category', targetId: category.id, details: { shortName: category.shortName, changed } };
      return { category, notices: [] };
    },
  },
  {
    method: 'POST',
    url: '/api/member/categories/:id/move-questions',
    auth: 'member',
    writesData: true,
    operationId: 'moveCategoryQuestions',
    tag: 'categories',
    summary: "Move every question of a category to another category.",
    description: 'Moderators only, at the version of the category the questions leave. Questions of every status move, each with a new version; saved results keep their category. The category can then be deleted.',
    schema: { params: S.CategoryIdParams, body: S.CategoryMoveBody, response: { 200: S.CategoryMoveResult } },
    handler: (context, request) => {
      const { targetCategoryId, version } = request.body as { targetCategoryId: string; version: number };
      const { source, target, moved, duplicates } = new CategoryService(context, request.member!).moveQuestions((request.params as { id: string }).id, version, targetCategoryId);
      request.audit = { targetType: 'category', targetId: source.id, details: { shortName: source.shortName, to: target.id, toShortName: target.shortName, moved } };
      const notices = duplicates ? [fieldError('targetCategoryId', 'duplicate', `${duplicates} moved questions have the same text as questions ${target.name} already had.`, { count: duplicates })] : [];
      return { source, target, moved, notices };
    },
  },
  {
    method: 'DELETE',
    url: '/api/member/categories/:id',
    auth: 'member',
    writesData: true,
    operationId: 'deleteCategory',
    tag: 'categories',
    summary: 'Delete a category without questions.',
    description: 'Moderators only. A category with questions of any status answers `409 category_not_empty`: move or delete them first.',
    schema: { params: S.CategoryIdParams, querystring: S.CategoryDeleteQuery, response: { 204: S.NoContent } },
    handler: (context, request, reply) => {
      const version = Number((request.query as { version: string }).version);
      const category = new CategoryService(context, request.member!).delete((request.params as { id: string }).id, version);
      request.audit = { targetType: 'category', targetId: category.id, details: { shortName: category.shortName } };
      reply.code(204);
      return null;
    },
  },
];
