import type { MemberSession, PublicCategory, PublicQuiz, PublicSettings, QuizLength } from './api.js';
import { ApiError, apiRequest } from './client.js';

/** The player UI's API calls, all through `apiRequest()` (FE-2). Nothing is cached in the browser (FE-3). */

export const getPublicSettings = () => apiRequest<PublicSettings>('/api/settings/public');

export const listCategories = () => apiRequest<PublicCategory[]>('/api/categories');

export const getQuiz = (categoryId: string, length: QuizLength) => (
  apiRequest<PublicQuiz>(`/api/categories/${encodeURIComponent(categoryId)}/quiz?length=${length}`)
);

// --- Member accounts (#17) ---------------------------------------------------------

/** The signed-in member, or null when there is none (a `401` here only means "signed out"). */
export async function getMemberSession(): Promise<MemberSession | null> {
  try {
    return await apiRequest<MemberSession>('/api/member/session');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export const memberSignIn = (username: string, password: string) => (
  apiRequest<MemberSession>('/api/member/login', { method: 'POST', body: { username, password } })
);

export const memberSignOut = () => apiRequest<void>('/api/member/logout', { method: 'POST' });

export const changeMemberPassword = (currentPassword: string, password: string) => (
  apiRequest<MemberSession>('/api/member/password', { method: 'POST', body: { currentPassword, password } })
);
