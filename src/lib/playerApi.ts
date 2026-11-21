import type { CategoryBody, CategoryStats, MyRanked, RankedLeaderboard, RankedQuestion, RankedRun, ManagedCategory, QuizResultRecord, MemberQuestion, MemberQuestionStatus, MemberSession, PublicCategory, PublicLeaderboard, PublicQuiz, PublicSettings, QuestionBody, QuestionCounts, QuestionPage, QuestionReport, QuizLength } from './api.js';
import type { FieldError } from './errors.js';
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

/** AGT sign-in (#18): the password goes only to AGT IAM, through the server. */
export const memberIamSignIn = (travellerName: string, password: string) => (
  apiRequest<MemberSession>('/api/member/iam/login', { method: 'POST', body: { travellerName, password } })
);

// --- Question authoring and review (#19) -------------------------------------------

export interface QuestionQuery {
  status?: MemberQuestionStatus;
  mine?: boolean;
  /** Part of the question text (#73). */
  q?: string;
  categoryId?: string;
  cursor?: string | null;
  limit?: number;
}

export interface QuestionResult {
  question: MemberQuestion;
  notices: FieldError[];
}

export function listQuestions(query: QuestionQuery = {}) {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.mine) params.set('mine', 'true');
  if (query.q) params.set('q', query.q);
  if (query.categoryId) params.set('categoryId', query.categoryId);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit) params.set('limit', String(query.limit));
  const search = params.toString();
  return apiRequest<QuestionPage>(`/api/member/questions${search ? `?${search}` : ''}`);
}

export const getQuestionCounts = () => apiRequest<QuestionCounts>('/api/member/question-counts');

export const createQuestion = (body: QuestionBody) => (
  apiRequest<QuestionResult>('/api/member/questions', { method: 'POST', body })
);

export const replaceQuestion = (id: string, version: number, body: QuestionBody) => (
  apiRequest<QuestionResult>(`/api/member/questions/${encodeURIComponent(id)}`, { method: 'PUT', body: { ...body, version } })
);

export const deleteQuestion = (id: string, version: number) => (
  apiRequest<void>(`/api/member/questions/${encodeURIComponent(id)}?version=${version}`, { method: 'DELETE' })
);

/** submit, approve or unpublish. */
export const changeQuestionStatus = (id: string, version: number, verb: 'submit' | 'approve' | 'unpublish') => (
  apiRequest<MemberQuestion>(`/api/member/questions/${encodeURIComponent(id)}/${verb}`, { method: 'POST', body: { version } })
);

export const rejectQuestion = (id: string, version: number, reviewNote: string) => (
  apiRequest<MemberQuestion>(`/api/member/questions/${encodeURIComponent(id)}/reject`, { method: 'POST', body: { version, reviewNote } })
);

// --- Category management (#20) -----------------------------------------------------

export const listManagedCategories = () => apiRequest<ManagedCategory[]>('/api/member/categories');

export const createCategory = (body: CategoryBody) => (
  apiRequest<{ category: ManagedCategory; notices: FieldError[] }>('/api/member/categories', { method: 'POST', body })
);

export const replaceCategory = (id: string, version: number, body: CategoryBody) => (
  apiRequest<{ category: ManagedCategory; notices: FieldError[] }>(`/api/member/categories/${encodeURIComponent(id)}`, { method: 'PUT', body: { ...body, version } })
);

export const deleteCategory = (id: string, version: number) => (
  apiRequest<void>(`/api/member/categories/${encodeURIComponent(id)}?version=${version}`, { method: 'DELETE' })
);

// --- Member score history (#21) ----------------------------------------------------

/** Sends a finished quiz's answers; the server grades them and keeps the result. */
/** Saves a finished quiz with its signed attempt (#45); sending the same attempt again returns the saved result. */
export const saveResult = (categoryId: string, length: QuizLength, attemptToken: string, answers: readonly { questionId: string; choiceIds: readonly string[] }[]) => (
  apiRequest<{ result: QuizResultRecord; skippedQuestionIds: string[]; notices: FieldError[] }>('/api/member/results', {
    method: 'POST',
    body: { categoryId, length, attemptToken, answers },
  })
);

export function listResults(query: { categoryId?: string; cursor?: string | null } = {}) {
  const params = new URLSearchParams();
  if (query.categoryId) params.set('categoryId', query.categoryId);
  if (query.cursor) params.set('cursor', query.cursor);
  const search = params.toString();
  return apiRequest<{ items: QuizResultRecord[]; nextCursor: string | null }>(`/api/member/results${search ? `?${search}` : ''}`);
}

export const getMemberStats = () => apiRequest<CategoryStats[]>('/api/member/stats');

export const clearResults = () => apiRequest<void>('/api/member/results', { method: 'DELETE' });

// --- Question reports (#46) ----------------------------------------------------------

export const reportQuestion = (questionId: string, reason: string, note: string) => (
  apiRequest<QuestionReport>(`/api/member/questions/${encodeURIComponent(questionId)}/reports`, { method: 'POST', body: { reason, note } })
);

/** Moderators: the open reports, oldest first. */
export function listReports(cursor: string | null = null) {
  const search = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return apiRequest<{ items: QuestionReport[]; nextCursor: string | null }>(`/api/member/reports${search}`);
}

export const closeReport = (id: string, version: number, verb: 'resolve' | 'dismiss', resolutionNote: string) => (
  apiRequest<QuestionReport>(`/api/member/reports/${encodeURIComponent(id)}/${verb}`, { method: 'POST', body: { version, resolutionNote } })
);

// --- Moving a category's questions (#47) -----------------------------------------------

export const moveCategoryQuestions = (id: string, version: number, targetCategoryId: string) => (
  apiRequest<{ source: ManagedCategory; target: ManagedCategory; moved: number; notices: FieldError[] }>(
    `/api/member/categories/${encodeURIComponent(id)}/move-questions`,
    { method: 'POST', body: { targetCategoryId, version } },
  )
);

// --- Leaderboards (#49) --------------------------------------------------------------

export const getLeaderboard = (categoryId: string) => apiRequest<PublicLeaderboard>(`/api/categories/${encodeURIComponent(categoryId)}/leaderboard`);

export const getMemberPreferences = () => apiRequest<{ leaderboardOptIn: boolean }>('/api/member/preferences');

export const setMemberPreferences = (leaderboardOptIn: boolean) => (
  apiRequest<{ leaderboardOptIn: boolean }>('/api/member/preferences', { method: 'PUT', body: { leaderboardOptIn } })
);

// --- Ranked mode (#66) ---

export const startRankedRun = () => apiRequest<{ run: RankedRun; notices: FieldError[] }>('/api/member/ranked/runs', { method: 'POST' });

export const nextRankedQuestion = (runId: string) => (
  apiRequest<{ run: RankedRun; question: RankedQuestion | null }>(`/api/member/ranked/runs/${encodeURIComponent(runId)}/next`, { method: 'POST' })
);

export const answerRankedQuestion = (runId: string, position: number, choiceIds: readonly string[]) => (
  apiRequest<{ run: RankedRun; late: boolean }>(`/api/member/ranked/runs/${encodeURIComponent(runId)}/answers`, { method: 'POST', body: { position, choiceIds } })
);

export const getMyRanked = () => apiRequest<MyRanked>('/api/member/ranked/me');

export const getRankedLeaderboard = () => apiRequest<RankedLeaderboard>('/api/ranked/leaderboard');
