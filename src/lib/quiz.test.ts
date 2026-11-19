import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCorrectSelection, questionsForQuiz, rankForPercent, shuffle, sortCategories } from './quiz.js';

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
    assert.equal(rankForPercent(100), 'atlasArchivist');
    assert.equal(rankForPercent(99), 'galacticCartographer');
    assert.equal(rankForPercent(75), 'galacticCartographer');
    assert.equal(rankForPercent(74), 'seasonedTraveller');
    assert.equal(rankForPercent(50), 'seasonedTraveller');
    assert.equal(rankForPercent(49), 'pathfinder');
    assert.equal(rankForPercent(0), 'pathfinder');
  });
});
