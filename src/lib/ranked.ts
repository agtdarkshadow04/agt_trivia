import { shuffle } from './quiz.js';

/**
 * Ranked mode's rules (#66), shared by the server, which scores every run, and
 * the browser, which only explains them. A correct answer earns `base` points
 * plus a speed bonus of up to `speedBonus`, falling linearly to 0 at the time
 * limit; an answer later than the limit plus `graceMs` scores 0. Each correct
 * answer in a row after the first adds `streakStep`, up to `streakCap`.
 */
export const RANKED_SCORING = {
  base: 100,
  speedBonus: 50,
  streakStep: 10,
  streakCap: 50,
  /** Network delay allowed after the time limit. */
  graceMs: 2000,
  /** Members with fewer ended runs are listed as provisional, below the ranked ones. */
  provisionalRuns: 3,
} as const;

/** Whether an answer `elapsedMs` after its question was shown is too late for a `limitMs` limit. */
export function isLate(elapsedMs: number, limitMs: number) {
  return elapsedMs > limitMs + RANKED_SCORING.graceMs;
}

/** The points of one answer before the streak bonus: 0 when wrong or late. */
export function answerPoints(correct: boolean, elapsedMs: number, limitMs: number) {
  if (!correct || isLate(elapsedMs, limitMs)) return 0;
  const used = Math.min(Math.max(elapsedMs, 0), limitMs) / limitMs;
  return RANKED_SCORING.base + Math.round(RANKED_SCORING.speedBonus * (1 - used));
}

/**
 * The streak bonus of each question, in the order played: the n-th correct
 * answer in a row earns `streakStep × (n − 1)`, at most `streakCap`; a wrong,
 * late or missing answer ends the streak. Questions left out (`null`) neither
 * count nor break it.
 */
export function streakBonuses(correct: readonly (boolean | null)[]) {
  let streak = 0;
  return correct.map((answer) => {
    if (answer === null) return 0;
    if (!answer) { streak = 0; return 0; }
    streak += 1;
    return Math.min(RANKED_SCORING.streakStep * (streak - 1), RANKED_SCORING.streakCap);
  });
}

/**
 * Draws `count` questions spread across their categories: the categories in a
 * random order, then one random question from each in turn, so a large
 * category cannot fill a run while others have questions left. Fewer when the
 * pool is smaller.
 */
export function drawSpread<T extends { categoryId: string }>(pool: readonly T[], count: number, random: () => number = Math.random): T[] {
  const byCategory = new Map<string, T[]>();
  for (const item of pool) byCategory.set(item.categoryId, [...(byCategory.get(item.categoryId) ?? []), item]);
  const queues = shuffle([...byCategory.values()], random).map((items) => shuffle(items, random));
  const drawn: T[] = [];
  while (drawn.length < count && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      if (drawn.length >= count) break;
      const next = queue.shift();
      if (next) drawn.push(next);
    }
  }
  // The round-robin order would always open with the same category order: shuffle the run itself.
  return shuffle(drawn, random);
}
