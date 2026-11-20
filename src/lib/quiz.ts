import type { QuizLength } from './api.js';

/**
 * Quiz logic without a DOM (FE-8), ported from the 1.x static app
 * (`src/lib/quiz.js`). The player UI (#16) builds on it.
 */

export interface SortableCategory {
  name: string;
  priority: number;
}

/** Lower priority first, then by name, ignoring case and accents. */
export function sortCategories<T extends SortableCategory>(categories: readonly T[]): T[] {
  return [...categories].sort(
    (first, second) => first.priority - second.priority
      || first.name.localeCompare(second.name, undefined, { sensitivity: 'base' }),
  );
}

/**
 * The quiz lengths worth offering for a category of `count` approved
 * questions (#43): a length only when it gives fewer questions than the next
 * longer one, and always the full quiz (quiz.longLength is always more than
 * quiz.shortLength, CFG-8). With 6 questions and lengths 10/30
 * that is only `all`; with 20, `short` and `all`; with 40, all three.
 */
export function availableLengths(count: number, shortLength: number, longLength: number): QuizLength[] {
  const lengths: QuizLength[] = [];
  if (shortLength < count) lengths.push('short');
  if (longLength < count) lengths.push('long');
  lengths.push('all');
  return lengths;
}

/** A shuffled copy (Fisher–Yates); the input is left as it is. */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

/** `count` random questions, or all of them when `count` is undefined or larger than the pool. */
export function questionsForQuiz<T>(questions: readonly T[], count?: number, random: () => number = Math.random): T[] {
  const shuffled = shuffle(questions, random);
  return count === undefined ? shuffled : shuffled.slice(0, count);
}

/** Exactly the correct set: every correct choice selected and nothing else, in any order. */
export function isCorrectSelection(selected: readonly string[], correct: readonly string[]): boolean {
  const correctSet = new Set(correct);
  const selectedSet = new Set(selected);
  return selectedSet.size === correctSet.size && [...selectedSet].every((choice) => correctSet.has(choice));
}

/** The rank titles, keys into the translations. */
export type Rank = 'atlasArchivist' | 'galacticCartographer' | 'seasonedTraveller' | 'pathfinder';

/**
 * The rank a score earns, from the exact score (#42): every answer right, at
 * least 75 %, at least 50 %, or below. Never from a rounded percentage, which
 * would make 199 of 200 perfect.
 */
export function rankFor(score: number, total: number): Rank {
  if (total <= 0) return 'pathfinder';
  if (score >= total) return 'atlasArchivist';
  if (score * 100 >= total * 75) return 'galacticCartographer';
  if (score * 100 >= total * 50) return 'seasonedTraveller';
  return 'pathfinder';
}

/**
 * An exact percentage (0 to 100) rounded for display (#42): 100 only when it
 * is exactly 100, 0 only when it is exactly 0, otherwise 1 to 99. So 199 of
 * 200 shows 99 %, and 1 of 300 shows 1 %.
 */
export function displayPercent(exact: number): number {
  if (exact >= 100) return 100;
  if (exact <= 0) return 0;
  return Math.min(99, Math.max(1, Math.round(exact)));
}

/** A score as a percentage for display, 0 when there were no questions (#42). */
export function scorePercent(score: number, total: number): number {
  if (total <= 0) return 0;
  if (score >= total) return 100;
  return displayPercent((score * 100) / total);
}
