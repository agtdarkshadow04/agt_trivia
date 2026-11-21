import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pointsAttribute, trendPoints } from './trend.js';

describe('the score trend line (#72)', () => {
  it('draws nothing for fewer than 2 results', () => {
    assert.deepEqual(trendPoints([]), []);
    assert.deepEqual(trendPoints([80]), []);
  });

  it('spaces the points evenly, oldest first, on a fixed 0–100 % scale', () => {
    const points = trendPoints([0, 50, 100], 100, 40, 0);
    assert.deepEqual(points, [{ x: 0, y: 40 }, { x: 50, y: 20 }, { x: 100, y: 0 }]);
    assert.equal(pointsAttribute(points), '0,40 50,20 100,0');
  });

  it('keeps the padding and clamps values outside 0–100', () => {
    const points = trendPoints([120, -5], 120, 36, 3);
    assert.deepEqual(points, [{ x: 3, y: 3 }, { x: 117, y: 33 }]);
  });

  it('rounds coordinates to two decimals', () => {
    const [, second] = trendPoints([0, 33, 100], 100, 30, 0);
    assert.deepEqual(second, { x: 50, y: 20.1 });
  });
});
