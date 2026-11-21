import type { AdminMember, MemberRole } from '../lib/api';
import { ApiError, apiFetch, apiRequest, attachmentName, type RequestOptions } from '../lib/client';
import type { FieldError } from '../lib/errors';

/**
 * The admin dashboard's API calls, all through `apiRequest()` (FE-2). A `401`
 * from any admin route except the credential checks means the session ended;
 * the dashboard then shows the sign-in screen.
 */

export interface SetupStatus {
  adminExists: boolean;
  setupPasswordConfigured: boolean;
}

export interface AdminSession {
  username: string;
  version: string;
  setupPasswordStillSet: boolean;
  /** BAK-11: a restore failed and could not be rolled back; only the Backup & restore tab works. */
  restoreFailed: boolean;
}

export type SettingValue = string | number | boolean;

export interface SettingState {
  key: string;
  value: SettingValue;
  source: 'config' | 'dashboard' | 'default';
  locked: boolean;
  default: SettingValue;
  description: string;
}

/** Sent on `window` when an admin request finds the session ended. */
export const adminUnauthorizedEvent = 'agt_trivia_admin_unauthorized';

/** Paths whose 401 means "wrong credentials", not "the session ended". */
const credentialPaths = ['/api/admin/login', '/api/admin/password', '/api/setup'];

async function adminRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  try {
    return await apiRequest<T>(path, options);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401 && !credentialPaths.includes(path)) {
      window.dispatchEvent(new Event(adminUnauthorizedEvent));
    }
    throw error;
  }
}

export const getSetupStatus = () => apiRequest<SetupStatus>('/api/setup/status');

export async function completeSetup(input: { setupPassword: string; username: string; password: string }) {
  await apiRequest('/api/setup', { method: 'POST', body: input });
  return getSession();
}

export async function signIn(username: string, password: string) {
  await apiRequest('/api/admin/login', { method: 'POST', body: { username, password } });
  return getSession();
}

/** The current session, or null when there is none (a `401` here is not an ended session). */
export async function getSession(): Promise<AdminSession | null> {
  try {
    return await apiRequest<AdminSession>('/api/admin/session');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export const signOut = () => adminRequest<void>('/api/admin/logout', { method: 'POST' });

export async function changePassword(currentPassword: string, password: string) {
  await adminRequest('/api/admin/password', { method: 'POST', body: { currentPassword, password } });
  return getSession();
}

// --- Backup and restore (§12) --------------------------------------------------

export type RestoreWarningCode = 'no_admin' | 'set_aside_not_deleted';

export interface DiffLine {
  kind: '+' | '-' | ' ';
  text: string;
}

/** What a preview found, and what a restore did (BAK-3, BAK-4). */
export interface RestoreReport {
  createdAt: string;
  appVersion: string;
  schemaVersion: { backup: number; current: number };
  counts: { categories: number; questions: number; members: number; admin: number; settings: number };
  adminUsername: string | null;
  ignoredSettings: string[];
  warningCodes: RestoreWarningCode[];
  config: { included: boolean; identical: boolean; diff: DiffLine[]; content: string | null };
  preRestoreBackup: string | null;
}

/** Downloads a backup archive (BAK-1). */
export async function downloadBackup() {
  try {
    const response = await apiFetch('/api/admin/backup', { accept: 'application/zip' });
    return { blob: await response.blob(), filename: attachmentName(response, 'agt-trivia-backup.zip') };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) window.dispatchEvent(new Event(adminUnauthorizedEvent));
    throw error;
  }
}

function restoreForm(action: 'preview' | 'restore', file: File) {
  const form = new FormData();
  form.append('action', action);
  form.append('backup', file);
  return form;
}

export const previewBackup = (file: File) => adminRequest<RestoreReport>('/api/admin/restore', { method: 'POST', body: restoreForm('preview', file) });
export const restoreBackup = (file: File) => adminRequest<RestoreReport>('/api/admin/restore', { method: 'POST', body: restoreForm('restore', file) });

/** AGT sign-in (#18): on, usable, and what the server still needs. */
export interface IamStatus {
  enabled: boolean;
  available: boolean;
  missing: ('baseUrl' | 'appId' | 'apiKey')[];
}

export const listSettings = () => adminRequest<{ settings: SettingState[]; iam: IamStatus }>('/api/admin/settings');

export const updateSettings = (values: Record<string, SettingValue | null>) => (
  adminRequest<{ settings: SettingState[]; iam: IamStatus }>('/api/admin/settings', { method: 'PUT', body: { values } })
);

// --- Ranked mode (#66) ----------------------------------------------------------

export interface RankedCategory {
  id: string;
  shortName: string;
  name: string;
  questionCount: number;
  ranked: boolean;
}

export const listRankedCategories = () => adminRequest<RankedCategory[]>('/api/admin/ranked/categories');

export const saveRankedCategories = (categories: readonly { id: string; ranked: boolean }[]) => (
  adminRequest<{ categories: RankedCategory[] }>('/api/admin/ranked/categories', { method: 'PUT', body: { categories } })
);

// --- Logs (LOG-18) -------------------------------------------------------------

export type LogKind = 'server' | 'audit';

export interface ServerLogEntry {
  id: string;
  at: string;
  level: 'info' | 'warn' | 'error' | 'fatal';
  source: string;
  message: string;
  requestId: string | null;
  details: Record<string, unknown>;
}

export interface AuditLogEntry {
  id: string;
  at: string;
  lastAt: string;
  count: number;
  actorType: 'admin' | 'anonymous';
  actor: string | null;
  ipHash: string | null;
  client: 'web' | 'api';
  action: string;
  method: string;
  route: string;
  targetType: string | null;
  targetId: string | null;
  outcome: 'success' | 'denied' | 'rate_limited' | 'failure';
  statusCode: number;
  requestId: string | null;
  details: Record<string, unknown>;
}

export interface LogPage<Entry> {
  items: Entry[];
  nextCursor: string | null;
}

export interface ServerLogSummary {
  unseenWarnings: number;
  unseenErrors: number;
}

/** The filters of either log; empty values are left out of the query. */
export type LogFilters = Partial<Record<'level' | 'source' | 'actorType' | 'action' | 'outcome' | 'targetType' | 'targetId' | 'from' | 'to' | 'q', string>>;

function logQuery(filters: LogFilters, extra: Record<string, string> = {}) {
  const query = new URLSearchParams(Object.entries({ ...filters, ...extra }).filter(([, value]) => value) as [string, string][]);
  return query.size ? `?${query}` : '';
}

export const listServerLog = (filters: LogFilters, cursor = '') => adminRequest<LogPage<ServerLogEntry>>(`/api/admin/logs/server${logQuery(filters, { cursor })}`);
export const listAuditLog = (filters: LogFilters, cursor = '') => adminRequest<LogPage<AuditLogEntry>>(`/api/admin/logs/audit${logQuery(filters, { cursor })}`);
export const getServerLogSummary = () => adminRequest<ServerLogSummary>('/api/admin/logs/server/summary');
export const markServerLogSeen = () => adminRequest<void>('/api/admin/logs/server/seen', { method: 'POST' });
export const clearServerLog = () => adminRequest<void>('/api/admin/logs/server', { method: 'DELETE' });

/** Downloads the entries matching `filters` as JSON Lines or CSV (LOG-22). */
export async function exportLog(log: LogKind, filters: LogFilters, format: 'jsonl' | 'csv') {
  try {
    const response = await apiFetch(`/api/admin/logs/${log}/export${logQuery(filters, { format })}`);
    return { blob: await response.blob(), filename: attachmentName(response, `agt-trivia-${log}-log.${format}`) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) window.dispatchEvent(new Event(adminUnauthorizedEvent));
    throw error;
  }
}

// --- Members (#17) -----------------------------------------------------------

export interface MemberPage {
  items: AdminMember[];
  nextCursor: string | null;
}

/** `idleDays` (#48): only members who never signed in or not for that many days; 0 for everyone. */
export function listMembers(search: string, cursor: string | null, idleDays = 0) {
  const query = new URLSearchParams(Object.entries({ q: search.trim(), cursor: cursor ?? '', idleDays: idleDays ? String(idleDays) : '' }).filter(([, value]) => value));
  return adminRequest<MemberPage>(`/api/admin/members${query.size ? `?${query}` : ''}`);
}

export const createMember = (input: { username: string; displayName: string; role: MemberRole; password: string }) => (
  adminRequest<{ member: AdminMember }>('/api/admin/members', { method: 'POST', body: input })
);

export const replaceMember = (id: string, input: { displayName: string; role: MemberRole; isActive: boolean }) => (
  adminRequest<{ member: AdminMember }>(`/api/admin/members/${encodeURIComponent(id)}`, { method: 'PUT', body: input })
);

export const setMemberPassword = (id: string, password: string) => (
  adminRequest<AdminMember>(`/api/admin/members/${encodeURIComponent(id)}/password`, { method: 'POST', body: { password } })
);

export const deleteMember = (id: string) => adminRequest<void>(`/api/admin/members/${encodeURIComponent(id)}`, { method: 'DELETE' });

// --- The sheet import (#22) -------------------------------------------------------

/** What an import of the 1.x sheet does, or did. */
export interface ImportReport {
  action: 'preview' | 'import';
  imported: boolean;
  categories: { create: number; skip: number };
  questions: { create: number; skip: number; approved: number; pending: number };
  /** Every bad row: `field` is the file, `params.row` the sheet row and `params.column` the column. */
  problems: FieldError[];
}

export function importSheet(action: 'preview' | 'import', files: { categories: File | null; questions: File | null }) {
  const form = new FormData();
  form.append('action', action);
  if (files.categories) form.append('categories', files.categories);
  if (files.questions) form.append('questions', files.questions);
  return adminRequest<ImportReport>('/api/admin/import', { method: 'POST', body: form });
}
