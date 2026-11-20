import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AdminMember } from '../src/lib/api.js';
import type { AppContext } from './context.js';
import { HttpError } from './http.js';
import { IamClient, type IamTraveller } from './iam.js';
import { AdminMemberService, MemberAuthService, type MemberInput, type MemberSessionResult, type MemberUpdate } from './members.js';
import type { RouteDefinition } from './routes.js';
import * as S from './schemas.js';
import { clearedCookie, memberSessionCookie, secureCookie, sessionCookie } from './session.js';

/**
 * Member accounts (#17, the AUTH-1 deviation): the member sign-in, session,
 * sign-out and password change, and the Admin's Members tab. Member routes
 * accept only the member cookie, Admin routes only the Admin's.
 */

function authLog(request: FastifyRequest) {
  return {
    error: (message: string) => request.log.error({ source: 'auth' }, message),
    info: (message: string) => request.log.info({ source: 'auth' }, message),
  };
}

function startMemberSession(context: AppContext, request: FastifyRequest, reply: FastifyReply, result: MemberSessionResult) {
  reply.header('set-cookie', sessionCookie(result.token, result.expiresAt, secureCookie(context, request), memberSessionCookie));
  // LOG-10: the member who just signed in is the actor.
  request.audit = { ...request.audit, actorType: 'member', actor: result.member.username ?? result.member.displayName };
  return result.member;
}

/** `?limit=` as a number from 1 to 200 (API-8). */
function pageLimit(limit: string | undefined) {
  if (limit === undefined) return undefined;
  const value = Number(limit);
  if (!Number.isInteger(value) || value < 1 || value > 200) throw new HttpError(400, 'invalid_request', 'limit must be 1 to 200.');
  return value;
}

export const memberRoutes: readonly RouteDefinition[] = [
  {
    method: 'POST',
    url: '/api/member/login',
    auth: 'csrf',
    // The member's last sign-in is recorded (#48).
    writesData: true,
    rateLimit: 'login',
    operationId: 'createMemberSession',
    tag: 'auth',
    summary: 'Sign a member in and set the member session cookie.',
    schema: { body: S.Credentials, response: { 200: S.MemberSession } },
    // The password is checked before the data write, so scrypt never holds the write lock (BAK-8).
    prepare: async (context, request) => {
      const { username, password } = request.body as { username: string; password: string };
      return new MemberAuthService(context).verifyLogin(username, password, authLog(request));
    },
    handler: (context, request, reply) => (
      startMemberSession(context, request, reply, new MemberAuthService(context).completeLogin(request.prepared as AdminMember))
    ),
  },
  {
    method: 'POST',
    url: '/api/member/iam/login',
    auth: 'csrf',
    // The first sign-in creates the member; every sign-in refreshes their role.
    writesData: true,
    rateLimit: 'login',
    operationId: 'createMemberIamSession',
    tag: 'auth',
    summary: 'Sign a member in with their AGT account through AGT IAM and set the member session cookie.',
    description: 'Available while `iam.enabled` is on and AGT IAM is configured (`403 iam_disabled`, `503 iam_unavailable` otherwise). The first sign-in creates the member; each sign-in sets the role from the AGT IAM tier through `iam.roleMap` (Player by default).',
    schema: { body: S.IamCredentials, response: { 200: S.MemberSession } },
    // AGT IAM is asked before the data write, so a slow answer never holds the write lock (BAK-8).
    prepare: async (context, request) => {
      const { travellerName, password } = request.body as { travellerName: string; password: string };
      const log = { error: (message: string) => request.log.error({ source: 'auth' }, message), warn: (message: string) => request.log.warn({ source: 'auth' }, message) };
      return new MemberAuthService(context).verifyIam(travellerName, password, new IamClient(context, log));
    },
    handler: (context, request, reply) => {
      const traveller = request.prepared as IamTraveller;
      const result = new MemberAuthService(context).completeIamLogin(traveller);
      // LOG-14: the traveller ID and tier, never the password or IAM's token.
      request.audit = { details: { travellerId: traveller.travellerId, permission: traveller.permission, role: traveller.role } };
      return startMemberSession(context, request, reply, result);
    },
  },
  {
    method: 'POST',
    url: '/api/member/logout',
    auth: 'member',
    writesData: false,
    operationId: 'deleteMemberSession',
    tag: 'auth',
    summary: 'Sign the member out and clear the member session cookie.',
    schema: { response: { 204: S.NoContent } },
    handler: (context, request, reply) => {
      new MemberAuthService(context).logout(request.cookies[memberSessionCookie]);
      reply.header('set-cookie', clearedCookie(secureCookie(context, request), memberSessionCookie)).code(204);
      return null;
    },
  },
  {
    method: 'GET',
    url: '/api/member/session',
    auth: 'member',
    writesData: false,
    operationId: 'getMemberSession',
    tag: 'auth',
    summary: 'Read the signed-in member.',
    schema: { response: { 200: S.MemberSession } },
    handler: (_context, request) => request.member,
  },
  {
    method: 'POST',
    url: '/api/member/password',
    auth: 'member',
    writesData: true,
    rateLimit: 'login',
    operationId: 'changeMemberPassword',
    tag: 'auth',
    summary: "Change the signed-in member's password, ending their other sessions.",
    description: 'Only for members with a local account (`403 forbidden` otherwise). Needs the current password.',
    schema: { body: S.PasswordChange, response: { 200: S.MemberSession } },
    handler: async (context, request, reply) => {
      const { currentPassword, password } = request.body as { currentPassword: string; password: string };
      const result = await new MemberAuthService(context).changePassword(request.member!.id, currentPassword, password, authLog(request));
      return startMemberSession(context, request, reply, result);
    },
  },
  {
    method: 'GET',
    url: '/api/admin/members',
    auth: 'admin',
    writesData: false,
    operationId: 'listMembers',
    tag: 'members',
    summary: 'List member accounts, newest first, one page at a time.',
    schema: { querystring: S.MemberListQuery, response: { 200: S.MemberPage } },
    handler: (context, request) => {
      const query = request.query as { limit?: string; cursor?: string; q?: string; idleDays?: string };
      const idleDays = query.idleDays === undefined ? undefined : Number(query.idleDays);
      if (idleDays !== undefined && idleDays > 3650) throw new HttpError(400, 'invalid_request', 'idleDays must be 1 to 3650.');
      return new AdminMemberService(context).list({ ...query, limit: pageLimit(query.limit), idleDays });
    },
  },
  {
    method: 'POST',
    url: '/api/admin/members',
    auth: 'admin',
    writesData: true,
    operationId: 'createMember',
    tag: 'members',
    summary: 'Create a local member account.',
    schema: { body: S.MemberCreateBody, response: { 201: S.MemberResult } },
    handler: async (context, request, reply) => {
      const member = await new AdminMemberService(context).create(request.body as MemberInput);
      request.audit = { targetType: 'member', targetId: member.id, details: { username: member.username, role: member.role } };
      reply.code(201);
      return { member, notices: [] };
    },
  },
  {
    method: 'PUT',
    url: '/api/admin/members/:id',
    auth: 'admin',
    writesData: true,
    operationId: 'replaceMember',
    tag: 'members',
    summary: "Replace a member's display name, role and active flag.",
    description: 'A role change or a deactivation signs the member out everywhere (AUTH-4).',
    schema: { params: S.MemberIdParams, body: S.MemberReplaceBody, response: { 200: S.MemberResult } },
    handler: (context, request) => {
      const { id } = request.params as { id: string };
      const { member, changed } = new AdminMemberService(context).replace(id, request.body as MemberUpdate);
      // LOG-14: the changed field names, and the new role, never the display name.
      request.audit = { targetType: 'member', targetId: member.id, details: { username: member.username, changed, ...(changed.includes('role') ? { role: member.role } : {}) } };
      return { member, notices: [] };
    },
  },
  {
    method: 'POST',
    url: '/api/admin/members/:id/password',
    auth: 'admin',
    writesData: true,
    operationId: 'setMemberPassword',
    tag: 'members',
    summary: "Set a local member's password and sign them out everywhere.",
    schema: { params: S.MemberIdParams, body: S.MemberPasswordBody, response: { 200: S.AdminMember } },
    handler: async (context, request) => {
      const { id } = request.params as { id: string };
      const member = await new AdminMemberService(context).setPassword(id, (request.body as { password: string }).password);
      request.audit = { targetType: 'member', targetId: member.id, details: { username: member.username } };
      return member;
    },
  },
  {
    method: 'DELETE',
    url: '/api/admin/members/:id',
    auth: 'admin',
    writesData: true,
    operationId: 'deleteMember',
    tag: 'members',
    summary: 'Delete a member account; their questions stay, without their name.',
    schema: { params: S.MemberIdParams, response: { 204: S.NoContent } },
    handler: (context, request, reply) => {
      const { id } = request.params as { id: string };
      const member = new AdminMemberService(context).delete(id);
      request.audit = { targetType: 'member', targetId: member.id, details: { username: member.username } };
      reply.code(204);
      return null;
    },
  },
];
