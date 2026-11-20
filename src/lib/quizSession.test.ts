import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PublicQuestion } from './api.js';
import { choiceState, choose, currentQuestion, isFinished, isMultiAnswer, lockAnswer, nextQuestion, quizResult, reviewAnswers, startSession } from './quizSession.js';

const single: PublicQuestion = {
  id: 'q1', prompt: 'Largest planet?', authorCredit: null,
  choices: [{ id: 'a', text: 'Jupiter' }, { id: 'b', text: 'Mars' }], correctChoiceIds: ['a'],
};
const multi: PublicQuestion = {
  id: 'q2', prompt: 'Gas giants?', authorCredit: 'Traveller',
  choices: [{ id: 'c', text: 'Jupiter' }, { id: 'd', text: 'Mars' }, { id: 'e', text: 'Saturn' }], correctChoiceIds: ['c', 'e'],
};

describe('a quiz session (#16)', () => {
  it('tells single- from multi-answer questions', () => {
    assert.equal(isMultiAnswer(single), false);
    assert.equal(isMultiAnswer(multi), true);
  });

  it('keeps one choice for a single-answer question and toggles them for a multi-answer one', () => {
    let session = startSession([single, multi]);
    session = choose(session, 'a');
    session = choose(session, 'b');
    assert.deepEqual(session.selected, ['b']);
    session = choose(session, 'unknown');
    assert.deepEqual(session.selected, ['b']);
    session = nextQuestion(lockAnswer(session));
    session = choose(choose(choose(session, 'c'), 'd'), 'e');
    assert.deepEqual(session.selected, ['c', 'd', 'e']);
    session = choose(session, 'd', false);
    assert.deepEqual(session.selected, ['c', 'e']);
  });

  it('locks only with a choice, grades it, and freezes the choices', () => {
    let session = startSession([single]);
    assert.equal(lockAnswer(session), session);
    assert.equal(choiceState(session, 'a'), null);
    session = lockAnswer(choose(session, 'a'));
    assert.equal(session.locked, true);
    assert.equal(session.lastCorrect, true);
    assert.equal(session.score, 1);
    assert.equal(choose(session, 'b'), session);
    assert.equal(lockAnswer(session), session);
    assert.equal(choiceState(session, 'a'), 'correct-chosen');
    assert.equal(choiceState(session, 'b'), 'other');
  });

  it('needs every correct answer of a multi-answer question and nothing else', () => {
    const partial = lockAnswer(choose(startSession([multi]), 'c'));
    assert.equal(partial.lastCorrect, false);
    assert.equal(partial.score, 0);
    assert.equal(choiceState(partial, 'c'), 'correct-chosen');
    assert.equal(choiceState(partial, 'e'), 'correct-missed');
    const extra = lockAnswer(choose(choose(choose(startSession([multi]), 'c'), 'e'), 'd'));
    assert.equal(extra.lastCorrect, false);
    assert.equal(choiceState(extra, 'd'), 'wrong-chosen');
    assert.equal(lockAnswer(choose(choose(startSession([multi]), 'e'), 'c')).lastCorrect, true);
  });

  it('moves on only after locking, then finishes with the score, percentage and rank', () => {
    let session = startSession([single, multi]);
    assert.equal(nextQuestion(session), session);
    session = nextQuestion(lockAnswer(choose(session, 'a')));
    assert.equal(currentQuestion(session), multi);
    assert.deepEqual(session.selected, []);
    session = nextQuestion(lockAnswer(choose(session, 'd')));
    assert.equal(isFinished(session), true);
    assert.equal(currentQuestion(session), null);
    assert.deepEqual(quizResult(session), { score: 1, total: 2, percent: 50, rank: 'seasonedTraveller' });
  });

  it('ranks a perfect score and an empty quiz', () => {
    const perfect = nextQuestion(lockAnswer(choose(startSession([single]), 'a')));
    assert.deepEqual(quizResult(perfect), { score: 1, total: 1, percent: 100, rank: 'atlasArchivist' });
    assert.deepEqual(quizResult(startSession([])), { score: 0, total: 0, percent: 0, rank: 'pathfinder' });
  });

  it('never rounds a near-perfect score up to a perfect one (#42)', () => {
    const played = { ...startSession(Array.from({ length: 200 }, () => single)), index: 200, score: 199 };
    assert.deepEqual(quizResult(played), { score: 199, total: 200, percent: 99, rank: 'galacticCartographer' });
  });
});

describe('the answers a member result sends (#21)', () => {
  it('records each locked answer in order, and nothing before locking', () => {
    let session = choose(startSession([single, multi]), 'b');
    assert.deepEqual(session.answers, []);
    session = nextQuestion(lockAnswer(session));
    session = lockAnswer(choose(choose(session, 'e'), 'c'));
    assert.deepEqual(session.answers, [{ questionId: 'q1', choiceIds: ['b'] }, { questionId: 'q2', choiceIds: ['e', 'c'] }]);
  });
});

describe('the end-of-quiz review (#44)', () => {
  it('lists every locked answer in the order played, with the chosen and the correct answers', () => {
    let session = startSession([multi, single]);
    session = nextQuestion(lockAnswer(choose(choose(session, 'e'), 'c')));
    session = nextQuestion(lockAnswer(choose(session, 'b')));
    assert.deepEqual(reviewAnswers(session), [
      { questionId: 'q2', prompt: 'Gas giants?', chosen: ['Jupiter', 'Saturn'], correct: ['Jupiter', 'Saturn'], right: true },
      { questionId: 'q1', prompt: 'Largest planet?', chosen: ['Mars'], correct: ['Jupiter'], right: false },
    ]);
  });

  it('marks a partly right multi-answer question wrong, and lists nothing before an answer is locked', () => {
    const fresh = startSession([multi]);
    assert.deepEqual(reviewAnswers(choose(fresh, 'c')), []);
    const [item] = reviewAnswers(lockAnswer(choose(fresh, 'c')));
    assert.deepEqual(item, { questionId: 'q2', prompt: 'Gas giants?', chosen: ['Jupiter'], correct: ['Jupiter', 'Saturn'], right: false });
  });
});
