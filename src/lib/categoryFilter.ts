import type { PublicCategory } from './api.js';

/**
 * The category list's filter (#74), in the browser: `GET /api/categories`
 * already returns every category. Matching ignores case and accents, and every
 * word of the query must appear in the name, the short name or the description.
 */

/** Lower case, without accents or extra spaces: "  Écologie " → "ecologie". */
export function normalizeSearch(text: string) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A category with its number in the full list, which it keeps while filtered. */
export interface NumberedCategory {
  category: PublicCategory;
  /** 1 for the first category of the full list. */
  number: number;
}

export function filterCategories(categories: readonly PublicCategory[], query: string): NumberedCategory[] {
  const words = normalizeSearch(query).split(' ').filter(Boolean);
  return categories
    .map((category, index) => ({ category, number: index + 1 }))
    .filter(({ category }) => {
      if (!words.length) return true;
      const haystack = normalizeSearch(`${category.name} ${category.shortName} ${category.description}`);
      return words.every((word) => haystack.includes(word));
    });
}
