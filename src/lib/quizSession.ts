import type { PublicQuestion } from './api.js';
import { isCorrectSelection, rankFor, scorePercent, type Rank } from './quiz.js';

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
  /** The locked answers so far, in order: what a member's result sends for grading on the server (#21). */
  answers: readonly { questionId: string; choiceIds: readonly string[] }[];
}

export function startSession(questions: readonly PublicQuestion[]): QuizSession {
  return { questions, index: 0, selected: [], locked: false, lastCorrect: false, score: 0, answers: [] };
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

/** At least one answer is locked and the results are not shown yet: leaving now loses the quiz (#67). */
export function isInProgress(session: QuizSession) {
  return session.answers.length > 0 && !isFinished(session);
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
  return {
    ...session,
    locked: true,
    lastCorrect: correct,
    score: session.score + (correct ? 1 : 0),
    answers: [...session.answers, { questionId: question.id, choiceIds: [...session.selected] }],
  };
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
  /** 0 to 100, rounded; 100 only for a perfect score and 0 only for none right (#42). */
  percent: number;
  rank: Rank;
}

export function quizResult(session: QuizSession): QuizResult {
  const total = session.questions.length;
  return { score: session.score, total, percent: scorePercent(session.score, total), rank: rankFor(session.score, total) };
}

/** One played question as the end-of-quiz review shows it (#44). */
export interface ReviewItem {
  questionId: string;
  prompt: string;
  /** The chosen and the correct answers' texts, in the order they were shown. */
  chosen: string[];
  correct: string[];
  right: boolean;
}

/**
 * Every locked answer with its question, in the order played (#44): what the
 * player chose, the correct answers, and whether it was right. Built from the
 * session alone, so anonymous play can review too; nothing is sent anywhere.
 */
export function reviewAnswers(session: QuizSession): ReviewItem[] {
  return session.answers.flatMap((answer) => {
    const question = session.questions.find((candidate) => candidate.id === answer.questionId);
    if (!question) return [];
    const texts = (ids: readonly string[]) => question.choices.filter((choice) => ids.includes(choice.id)).map((choice) => choice.text);
    return [{
      questionId: question.id,
      prompt: question.prompt,
      chosen: texts(answer.choiceIds),
      correct: texts(question.correctChoiceIds),
      right: isCorrectSelection(answer.choiceIds, question.correctChoiceIds),
    }];
  });
}
