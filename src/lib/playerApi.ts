import type { PublicCategory, PublicQuiz, PublicSettings, QuizLength } from './api.js';
import { apiRequest } from './client.js';

/** The player UI's API calls, all through `apiRequest()` (FE-2). Nothing is cached in the browser (FE-3). */

export const getPublicSettings = () => apiRequest<PublicSettings>('/api/settings/public');

export const listCategories = () => apiRequest<PublicCategory[]>('/api/categories');

export const getQuiz = (categoryId: string, length: QuizLength) => (
  apiRequest<PublicQuiz>(`/api/categories/${encodeURIComponent(categoryId)}/quiz?length=${length}`)
);
