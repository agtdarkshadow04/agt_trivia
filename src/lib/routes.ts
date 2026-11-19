/**
 * The player UI's deep links (FE-4): query parameters on `/`, never paths.
 * `?category=<shortName>` opens a category, matched ignoring case like 1.x;
 * an unknown code falls back to the category list.
 */

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
