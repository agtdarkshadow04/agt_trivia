import { COMMON_TRANSLATIONS, formatTranslation } from '../translations.js';
import { formatNumber, formatPercent, type FormatOptions } from './format.js';
import { searchWithCategory } from './routes.js';

/**
 * A finished quiz as a short text to share (#71): the product, the category,
 * the score, the percentage and the rank, in the reader's language and digits
 * (I18N-5), and the category's deep link (FE-4). Nothing is sent anywhere: the
 * browser's share sheet or clipboard takes it (SEC-14).
 */

export interface ShareInput {
  /** `t.quiz.shareText`, with `{{product}}`, `{{category}}`, `{{score}}`, `{{total}}`, `{{percent}}` and `{{rank}}`. */
  template: string;
  /** The category's name (English, I18N-2) and short name. */
  category: { name: string; shortName: string };
  score: number;
  total: number;
  /** 0 to 100. */
  percent: number;
  /** The rank's name in the reader's language. */
  rank: string;
  /** The page's origin, e.g. `https://trivia.example.org`. */
  origin: string;
}

export function shareSummary(input: ShareInput, format: Pick<FormatOptions, 'tag'>) {
  const text = formatTranslation(input.template, {
    product: COMMON_TRANSLATIONS.product,
    category: input.category.name,
    score: formatNumber(input.score, format),
    total: formatNumber(input.total, format),
    percent: formatPercent(input.percent, format),
    rank: input.rank,
  });
  const url = `${input.origin}/${searchWithCategory('', input.category.shortName)}`;
  return { text, url, combined: `${text} ${url}` };
}
