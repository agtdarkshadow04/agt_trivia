import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { categoryParam, findCategory, pageParam, searchForPage, searchWithCategory } from './routes.js';

describe('player deep links (FE-4)', () => {
  const categories = [{ shortName: 'Space' }, { shortName: 'bio-1' }];

  it('reads ?category=, ignoring an empty one', () => {
    assert.equal(categoryParam('?category=space'), 'space');
    assert.equal(categoryParam('?other=1&category=%20bio-1%20'), 'bio-1');
    assert.equal(categoryParam('?category='), null);
    assert.equal(categoryParam(''), null);
  });

  it('matches a category ignoring case, and nothing for an unknown code', () => {
    assert.equal(findCategory(categories, 'SPACE'), categories[0]);
    assert.equal(findCategory(categories, 'Bio-1'), categories[1]);
    assert.equal(findCategory(categories, 'nope'), null);
    assert.equal(findCategory(categories, null), null);
  });

  it('sets and removes the parameter, keeping the others', () => {
    assert.equal(searchWithCategory('', 'Space'), '?category=Space');
    assert.equal(searchWithCategory('?x=1&category=old', 'Space'), '?x=1&category=Space');
    assert.equal(searchWithCategory('?category=Space', null), '');
    assert.equal(searchWithCategory('?x=1&category=Space', null), '?x=1');
  });

  it('reads and writes the sign-in page (#17)', () => {
    assert.equal(pageParam('?page=login'), 'login');
    assert.equal(pageParam('?page=nope'), null);
    assert.equal(pageParam('?category=x'), null);
    assert.equal(searchForPage('login'), '?page=login');
    assert.equal(searchForPage(null), '');
  });
});
