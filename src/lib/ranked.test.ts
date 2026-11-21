import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { answerPoints, drawSpread, isLate, RANKED_SCORING, streakBonuses } from './ranked.js';

/** A seeded random number generator, so draws are repeatable. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe('ranked scoring (#66)', () => {
  it('gives a correct answer 100 points and a speed bonus falling from 50 to 0 at the limit', () => {
    assert.equal(answerPoints(true, 0, 20_000), 150);
    assert.equal(answerPoints(true, 10_000, 20_000), 125);
    assert.equal(answerPoints(true, 20_000, 20_000), 100);
    // Within the network allowance: correct, without a bonus.
    assert.equal(answerPoints(true, 21_500, 20_000), 100);
  });

  it('gives nothing for a wrong or late answer', () => {
    assert.equal(answerPoints(false, 1000, 20_000), 0);
    assert.equal(isLate(20_000 + RANKED_SCORING.graceMs, 20_000), false);
    assert.equal(isLate(20_000 + RANKED_SCORING.graceMs + 1, 20_000), true);
    assert.equal(answerPoints(true, 22_001, 20_000), 0);
  });

  it('adds 10 per correct answer in a row after the first, at most 50, and a miss ends the streak', () => {
    assert.deepEqual(streakBonuses([true, true, true, false, true, true]), [0, 10, 20, 0, 0, 10]);
    assert.deepEqual(streakBonuses(Array(8).fill(true)), [0, 10, 20, 30, 40, 50, 50, 50]);
  });

  it('lets a left-out question neither count nor break the streak', () => {
    assert.deepEqual(streakBonuses([true, null, true]), [0, 0, 10]);
  });
});

describe('the ranked draw (#66)', () => {
  const pool = [
    ...Array.from({ length: 20 }, (_, index) => ({ id: `big-${index}`, categoryId: 'big' })),
    ...Array.from({ length: 3 }, (_, index) => ({ id: `small-${index}`, categoryId: 'small' })),
    ...Array.from({ length: 3 }, (_, index) => ({ id: `tiny-${index}`, categoryId: 'tiny' })),
  ];

  it('spreads the run across the categories, so a large one cannot fill it', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const run = drawSpread(pool, 9, seeded(seed));
      assert.equal(run.length, 9);
      assert.equal(new Set(run.map((item) => item.id)).size, 9, 'no question twice');
      for (const category of ['big', 'small', 'tiny']) assert.equal(run.filter((item) => item.categoryId === category).length, 3, `seed ${seed}, ${category}`);
    }
  });

  it('fills up from the categories that still have questions', () => {
    const run = drawSpread(pool, 12, seeded(3));
    assert.equal(run.filter((item) => item.categoryId === 'big').length, 6);
  });

  it('draws fewer than asked from a smaller pool, and nothing from an empty one', () => {
    assert.equal(drawSpread(pool.slice(0, 4), 10).length, 4);
    assert.deepEqual(drawSpread([], 10), []);
  });
});
