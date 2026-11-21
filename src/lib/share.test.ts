import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shareSummary } from './share.js';

const base = {
  template: '{{product}} – {{category}}: {{score}}/{{total}} ({{percent}}) – {{rank}}',
  category: { name: 'Exploration', shortName: 'explore' },
  score: 9,
  total: 10,
  percent: 90,
  rank: 'Galactic Cartographer',
  origin: 'https://trivia.example.org',
};

describe('the shared result summary (#71)', () => {
  it('names the product, category, score, percentage and rank, then the deep link', () => {
    const summary = shareSummary(base, { tag: 'en' });
    assert.equal(summary.text, 'AGT Galactic Trivia – Exploration: 9/10 (90%) – Galactic Cartographer');
    assert.equal(summary.url, 'https://trivia.example.org/?category=explore');
    assert.equal(summary.combined, `${summary.text} ${summary.url}`);
  });

  it("uses the reader's digits and percent sign, and keeps the category name in English", () => {
    const french = shareSummary({ ...base, score: 1200, total: 1500, percent: 80, rank: 'Cartographe galactique' }, { tag: 'fr' });
    assert.match(french.text, /^AGT Galactic Trivia – Exploration: 1\s200\/1\s500 \(80\s%\) – Cartographe galactique$/);
    const hindi = shareSummary(base, { tag: 'hi' });
    assert.match(hindi.text, /Exploration/);
  });

  it('encodes the short name in the link', () => {
    assert.equal(shareSummary({ ...base, category: { name: 'Odd', shortName: 'a b&c' } }, { tag: 'en' }).url, 'https://trivia.example.org/?category=a+b%26c');
  });
});
