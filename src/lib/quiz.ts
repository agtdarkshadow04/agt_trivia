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

/** The rank a score earns: 100 %, at least 75 %, at least 50 %, or below. */
export function rankForPercent(percent: number): Rank {
  if (percent >= 100) return 'atlasArchivist';
  if (percent >= 75) return 'galacticCartographer';
  if (percent >= 50) return 'seasonedTraveller';
  return 'pathfinder';
}
