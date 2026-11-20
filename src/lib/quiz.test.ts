import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { availableLengths, displayPercent, isCorrectSelection, questionsForQuiz, rankFor, scorePercent, shuffle, sortCategories } from './quiz.js';

describe('quiz helpers', () => {
  it('sorts by ascending priority and then by name', () => {
    const sorted = sortCategories([
      { name: 'Technology', priority: 20 },
      { name: 'lore', priority: 10 },
      { name: 'Exploration', priority: 10 },
    ]);
    assert.deepEqual(sorted.map((category) => category.name), ['Exploration', 'lore', 'Technology']);
  });

  it('selects short, long and full quizzes without changing the pool', () => {
    const questions = Array.from({ length: 35 }, (_, index) => index);
    assert.equal(questionsForQuiz(questions, 10, () => 0).length, 10);
    assert.equal(questionsForQuiz(questions, 30, () => 0).length, 30);
    assert.equal(questionsForQuiz(questions, undefined, () => 0).length, 35);
    assert.deepEqual(questions, Array.from({ length: 35 }, (_, index) => index));
  });

  it('uses every question when the requested length is longer than the pool', () => {
    assert.equal(questionsForQuiz([1, 2, 3], 10, () => 0).length, 3);
  });

  it('shuffles a copy and keeps every item', () => {
    const original = [1, 2, 3];
    assert.deepEqual(shuffle(original, () => 0), [2, 3, 1]);
    assert.deepEqual(original, [1, 2, 3]);
    assert.deepEqual([...shuffle(original)].sort(), [1, 2, 3]);
  });

  it('requires exactly the correct set for multi-answer questions', () => {
    assert.equal(isCorrectSelection(['gek', 'korvax'], ['korvax', 'gek']), true);
    assert.equal(isCorrectSelection(['gek'], ['korvax', 'gek']), false);
    assert.equal(isCorrectSelection(['gek', 'korvax', 'vykeen'], ['korvax', 'gek']), false);
    assert.equal(isCorrectSelection(['gek', 'gek'], ['gek', 'korvax']), false);
    assert.equal(isCorrectSelection([], ['gek']), false);
  });

  it('ranks scores as the 1.x app did', () => {
    assert.equal(rankFor(10, 10), 'atlasArchivist');
    assert.equal(rankFor(99, 100), 'galacticCartographer');
    assert.equal(rankFor(3, 4), 'galacticCartographer');
    assert.equal(rankFor(74, 100), 'seasonedTraveller');
    assert.equal(rankFor(1, 2), 'seasonedTraveller');
    assert.equal(rankFor(49, 100), 'pathfinder');
    assert.equal(rankFor(0, 10), 'pathfinder');
    assert.equal(rankFor(0, 0), 'pathfinder');
  });

  it('ranks by the exact score, never a rounded percentage (#42)', () => {
    assert.equal(rankFor(199, 200), 'galacticCartographer', '99.5 % is not perfect');
    assert.equal(rankFor(149, 200), 'seasonedTraveller', '74.5 % is below 75 %');
    assert.equal(rankFor(99, 200), 'pathfinder', '49.5 % is below 50 %');
    assert.equal(rankFor(150, 200), 'galacticCartographer');
    assert.equal(rankFor(100, 200), 'seasonedTraveller');
  });

  it('shows 100 % only for a perfect score and 0 % only for none right (#42)', () => {
    assert.equal(scorePercent(200, 200), 100);
    assert.equal(scorePercent(199, 200), 99);
    assert.equal(scorePercent(1, 300), 1);
    assert.equal(scorePercent(0, 300), 0);
    assert.equal(scorePercent(1, 3), 33);
    assert.equal(scorePercent(2, 3), 67);
    assert.equal(scorePercent(0, 0), 0);
    assert.equal(displayPercent(99.995), 99);
    assert.equal(displayPercent(0.2), 1);
    assert.equal(displayPercent(100), 100);
    assert.equal(displayPercent(0), 0);
    assert.equal(displayPercent(74.5), 75);
  });

  it('offers only the quiz lengths that differ, and always the full quiz (#43)', () => {
    assert.deepEqual(availableLengths(6, 10, 30), ['all']);
    assert.deepEqual(availableLengths(10, 10, 30), ['all'], 'a short quiz of 10 is the full one');
    assert.deepEqual(availableLengths(11, 10, 30), ['short', 'all']);
    assert.deepEqual(availableLengths(20, 10, 30), ['short', 'all']);
    assert.deepEqual(availableLengths(30, 10, 30), ['short', 'all'], 'a long quiz of 30 is the full one');
    assert.deepEqual(availableLengths(31, 10, 30), ['short', 'long', 'all']);
    assert.deepEqual(availableLengths(0, 10, 30), ['all']);
    assert.deepEqual(availableLengths(3, 1, 2), ['short', 'long', 'all']);
  });
});
