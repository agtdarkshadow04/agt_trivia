import type { PublicQuestion } from './api.js';
import { isCorrectSelection, rankForPercent, type Rank } from './quiz.js';

/**
 * One quiz being played (#16), without a DOM (FE-8): the questions, the
 * current one, the chosen answers, whether they are locked, and the score.
 * Each function returns a new state; components only render it. Anonymous
 * play is graded here, in the browser, as in 1.x.
 */

export interface QuizSession {
  questions: readonly PublicQuestion[];
  index: number;
  /** The chosen choice IDs of the current question. */
  selected: readonly string[];
  /** The answer is locked and its feedback shown. */
  locked: boolean;
  /** Whether the locked answer was right. */
  lastCorrect: boolean;
  score: number;
}

export function startSession(questions: readonly PublicQuestion[]): QuizSession {
  return { questions, index: 0, selected: [], locked: false, lastCorrect: false, score: 0 };
}

/** More than one correct choice: players pick every correct answer (checkboxes). */
export function isMultiAnswer(question: PublicQuestion) {
  return question.correctChoiceIds.length > 1;
}

export function currentQuestion(session: QuizSession): PublicQuestion | null {
  return session.questions[session.index] ?? null;
}

export function isFinished(session: QuizSession) {
  return session.index >= session.questions.length;
}

/**
 * Chooses or, for a multi-answer question, toggles a choice. Nothing changes
 * once the answer is locked, or for a choice the question does not have.
 */
export function choose(session: QuizSession, choiceId: string, checked = true): QuizSession {
  const question = currentQuestion(session);
  if (!question || session.locked || !question.choices.some((choice) => choice.id === choiceId)) return session;
  if (!isMultiAnswer(question)) return { ...session, selected: checked ? [choiceId] : [] };
  const others = session.selected.filter((id) => id !== choiceId);
  return { ...session, selected: checked ? [...others, choiceId] : others };
}

/** Locks the chosen answers and grades them; nothing happens without a choice. */
export function lockAnswer(session: QuizSession): QuizSession {
  const question = currentQuestion(session);
  if (!question || session.locked || !session.selected.length) return session;
  const correct = isCorrectSelection(session.selected, question.correctChoiceIds);
  return { ...session, locked: true, lastCorrect: correct, score: session.score + (correct ? 1 : 0) };
}

/** Moves on after the feedback: the next question, or the results after the last one. */
export function nextQuestion(session: QuizSession): QuizSession {
  if (!session.locked) return session;
  return { ...session, index: session.index + 1, selected: [], locked: false, lastCorrect: false };
}

/** How a choice is shown once the answer is locked; null before. */
export type ChoiceState = 'correct-chosen' | 'correct-missed' | 'wrong-chosen' | 'other';

export function choiceState(session: QuizSession, choiceId: string): ChoiceState | null {
  const question = currentQuestion(session);
  if (!question || !session.locked) return null;
  const correct = question.correctChoiceIds.includes(choiceId);
  const chosen = session.selected.includes(choiceId);
  if (correct) return chosen ? 'correct-chosen' : 'correct-missed';
  return chosen ? 'wrong-chosen' : 'other';
}

export interface QuizResult {
  score: number;
  total: number;
  /** 0 to 100, rounded. */
  percent: number;
  rank: Rank;
}

export function quizResult(session: QuizSession): QuizResult {
  const total = session.questions.length;
  const percent = total ? Math.round((session.score / total) * 100) : 0;
  return { score: session.score, total, percent, rank: rankForPercent(percent) };
}
