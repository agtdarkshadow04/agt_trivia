import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { categoryParam, findCategory, pageParam, searchForLeaderboard, searchForPage, searchWithCategory, viewParam } from './routes.js';

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

  it('reads and writes the sign-in page (#17) and the question pages (#19)', () => {
    assert.equal(pageParam('?page=login'), 'login');
    assert.equal(pageParam('?page=nope'), null);
    assert.equal(pageParam('?category=x'), null);
    assert.equal(searchForPage('login'), '?page=login');
    assert.equal(pageParam('?page=questions'), 'questions');
    assert.equal(pageParam('?page=review'), 'review');
    assert.equal(pageParam('?page=categories'), 'categories');
    assert.equal(pageParam('?page=scores'), 'scores');
    assert.equal(pageParam('?page=REVIEW'), null);
    assert.equal(searchForPage('review'), '?page=review');
    assert.equal(searchForPage(null), '');
  });

  it('reads and writes a category\'s leaderboard view (#49)', () => {
    assert.equal(viewParam('?category=space&view=leaderboard'), 'leaderboard');
    assert.equal(viewParam('?category=space&view=other'), null);
    assert.equal(viewParam('?category=space'), null);
    assert.equal(searchForLeaderboard('space'), '?category=space&view=leaderboard');
    assert.equal(categoryParam(searchForLeaderboard('space')), 'space');
    // Choosing another category leaves the view behind.
    assert.equal(searchWithCategory('', 'bio'), '?category=bio');
  });
});
