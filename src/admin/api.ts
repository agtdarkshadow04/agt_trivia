import { ApiError, apiFetch, apiRequest, attachmentName, type RequestOptions } from '../lib/client';

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

export const listSettings = () => adminRequest<{ settings: SettingState[] }>('/api/admin/settings');

export const updateSettings = (values: Record<string, SettingValue | null>) => (
  adminRequest<{ settings: SettingState[] }>('/api/admin/settings', { method: 'PUT', body: { values } })
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
