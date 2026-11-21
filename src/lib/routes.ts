/**
 * The player UI's deep links (FE-4): query parameters on `/`, never paths.
 * `?category=<shortName>` opens a category, matched ignoring case like 1.x;
 * an unknown code falls back to the category list. `?page=login` is the
 * member sign-in (#17); `?page=questions` and `?page=review` are the question
 * workshop and the review queue (#19); `?page=categories` is the Moderators'
 * category management (#20); `?page=scores` is a member's score history (#21).
 * `?category=<shortName>&view=leaderboard` is a category's leaderboard (#49).
 * `?page=ranked` is Ranked mode and `?page=board` its public board (#66).
 */

/** The pages besides the game itself. */
export const pages = ['login', 'questions', 'review', 'categories', 'scores', 'ranked', 'board'] as const;
export type Page = typeof pages[number];

/** The `page` parameter, or null for the game (an unknown page is the game too). */
export function pageParam(search: string): Page | null {
  const page = new URLSearchParams(search).get('page');
  return (pages as readonly (string | null)[]).includes(page) ? page as Page : null;
}

/** The address of a page: only `page` is kept, so a page never carries a category along. */
export function searchForPage(page: Page | null): string {
  return page ? `?page=${page}` : '';
}

export interface CategoryCode {
  shortName: string;
}

/** The `category` parameter of a query string, or null when it is absent or empty. */
export function categoryParam(search: string): string | null {
  const value = new URLSearchParams(search).get('category');
  return value && value.trim() ? value.trim() : null;
}

/** The category `code` names, ignoring case, or null. */
export function findCategory<T extends CategoryCode>(categories: readonly T[], code: string | null): T | null {
  if (code === null) return null;
  const wanted = code.toLowerCase();
  return categories.find((category) => category.shortName.toLowerCase() === wanted) ?? null;
}

/** `search` with `category` set to `shortName`, or removed for null; other parameters stay. */
export function searchWithCategory(search: string, shortName: string | null): string {
  const params = new URLSearchParams(search);
  if (shortName === null) params.delete('category');
  else params.set('category', shortName);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** A category's views besides playing it (#49). */
export type CategoryView = 'leaderboard';

/** The `view` parameter beside `category`, or null for the quiz itself. */
export function viewParam(search: string): CategoryView | null {
  return new URLSearchParams(search).get('view') === 'leaderboard' ? 'leaderboard' : null;
}

/** The address of a category's leaderboard. */
export function searchForLeaderboard(shortName: string): string {
  return `?${new URLSearchParams({ category: shortName, view: 'leaderboard' })}`;
}
