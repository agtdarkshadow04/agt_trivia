import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PublicCategory } from './api.js';
import { filterCategories, normalizeSearch } from './categoryFilter.js';

const category = (shortName: string, name: string, description: string): PublicCategory => ({
  id: `00000000-0000-4000-8000-${shortName.padStart(12, '0').slice(-12)}`, shortName, name, description, priority: 1, questionCount: 3,
});
const categories = [
  category('space', 'Space', 'Planets, stars and the void between them.'),
  category('freight', 'Freighters', 'Capital ships and their fleets.'),
  category('eco', 'Écologie', 'Flora and fauna of distant worlds.'),
];

describe('the category filter (#74)', () => {
  it('normalizes case, accents and spaces', () => {
    assert.equal(normalizeSearch('  Écologie   Spatiale '), 'ecologie spatiale');
    assert.equal(normalizeSearch('ÅNGSTRÖM'), 'angstrom');
  });

  it('keeps everything, numbered as in the full list, for an empty query', () => {
    assert.deepEqual(filterCategories(categories, '   ').map(({ number }) => number), [1, 2, 3]);
  });

  it('matches the name, the short name and the description, ignoring case and accents', () => {
    assert.deepEqual(filterCategories(categories, 'FREIGH').map(({ category: { shortName } }) => shortName), ['freight']);
    assert.deepEqual(filterCategories(categories, 'eco').map(({ category: { shortName } }) => shortName), ['eco']);
    assert.deepEqual(filterCategories(categories, 'ecologie').map(({ number }) => number), [3]);
    assert.deepEqual(filterCategories(categories, 'fleets').map(({ number }) => number), [2]);
  });

  it('needs every word, in any order, and finds nothing for a word no category has', () => {
    assert.deepEqual(filterCategories(categories, 'stars planets').map(({ number }) => number), [1]);
    assert.deepEqual(filterCategories(categories, 'stars fleets'), []);
    assert.deepEqual(filterCategories(categories, 'unicorn'), []);
  });
});
