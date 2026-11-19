import { ApiError, apiRequest, type RequestOptions } from '../lib/client';

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
