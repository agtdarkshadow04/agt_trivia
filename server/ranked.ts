import type { MemberSession } from '../src/lib/api.js';
import { isUuidV4 } from '../src/lib/api.js';
import { fieldError, type FieldError } from '../src/lib/errors.js';
import { isCorrectSelection, shuffle } from '../src/lib/quiz.js';
import { answerPoints, drawSpread, isLate, RANKED_SCORING, streakBonuses } from '../src/lib/ranked.js';
import { settingValues, type AppContext } from './context.js';
import { HttpError } from './http.js';
import { getQuestion } from './repository/questions.js';
import * as repo from './repository/ranked.js';
import { readSettings } from './repository/settings.js';

/**
 * Ranked mode (#66). The server owns every run: it draws the questions from
 * the categories the Admin includes (spread across them, leaving out what the
 * member saw within `ranked.cooldownDays`), shows them one at a time, keeps
 * the time from its own clock, and grades the answers. No response ever says
 * whether an answer was right or what the correct one is; a run's totals are
 * shown only once it has ended. A member's rating is the mean score of their
 * latest `ranked.ratingRuns` ended runs, forfeited ones included.
 */

/** How many of a member's ended runs `GET /api/member/ranked/me` lists. */
export const RANKED_HISTORY = 20;

export interface RankedRunView {
  id: string;
  status: repo.RunStatus;
  questionCount: number;
  secondsPerQuestion: number;
  /** The questions closed so far (answered, expired or left out). */
  closedCount: number;
  startedAt: string;
  finishedAt: string | null;
  /** The totals, only once the run has ended; null while it is active. */
  totals: RankedTotals | null;
}

export interface RankedTotals {
  score: number;
  correctCount: number;
  countedCount: number;
  /** The mean time of the answers given in time, in milliseconds; null without any. */
  averageAnswerMs: number | null;
  /** The member's rating after this run, and how it changed; null before their first. */
  rating: number;
  ratingChange: number | null;
}

export interface RankedQuestionView {
  position: number;
  prompt: string;
  /** Shuffled each time the question is shown. */
  choices: { id: string; text: string }[];
  /** More than one answer is correct: players choose every correct one. */
  multi: boolean;
  servedAt: string;
  /** The time limit, from the server's clock. */
  deadline: string;
  /** Milliseconds left until the deadline when the server answered, for a timer that ignores the browser's clock. */
  remainingMs: number;
}

export interface RankedBoardEntry {
  rank: number;
  displayName: string;
  rating: number;
  runs: number;
  accuracy: number;
}

function values(context: AppContext) {
  return settingValues(context.config, readSettings(context.db));
}

export function rankedEnabled(context: AppContext) {
  return values(context)['ranked.enabled'];
}

function requireOpen(context: AppContext) {
  const settings = values(context);
  if (!settings['ranked.enabled']) throw new HttpError(403, 'ranked_closed', 'Ranked mode is turned off.');
  return settings;
}

const roundRating = (rating: number) => Math.round(rating);
const accuracyOf = (correct: number, counted: number) => (counted > 0 ? Math.round((100 * correct) / counted) : 0);

/** Every opted-in member's board entry, best first: rating, then accuracy, then who reached it first. */
function sortedBoard(context: AppContext, ratingRuns: number) {
  return repo.boardRows(context.db, ratingRuns)
    .map((row) => ({ ...row, accuracy: accuracyOf(row.correct, row.counted) }))
    .sort((a, b) => b.rating - a.rating || b.accuracy - a.accuracy || a.ratedAt.localeCompare(b.ratedAt) || a.memberId.localeCompare(b.memberId));
}

/** The public board (`403 ranked_closed` while Ranked mode is off): display names only (API-3). */
export function publicRankedBoard(context: AppContext) {
  const settings = requireOpen(context);
  const board = sortedBoard(context, settings['ranked.ratingRuns']);
  const ranked = board.filter((row) => row.runs >= RANKED_SCORING.provisionalRuns);
  const provisional = board.filter((row) => row.runs < RANKED_SCORING.provisionalRuns).sort((a, b) => b.runs - a.runs || b.rating - a.rating);
  const size = settings['ranked.boardSize'];
  const entry = (row: (typeof board)[number]) => ({ displayName: row.displayName, rating: roundRating(row.rating), runs: row.runs, accuracy: row.accuracy });
  return {
    ratingRuns: settings['ranked.ratingRuns'],
    provisionalRuns: RANKED_SCORING.provisionalRuns,
    entries: ranked.slice(0, size).map((row, index) => ({ rank: index + 1, ...entry(row) })),
    provisional: provisional.slice(0, size).map(entry),
  };
}

export class RankedService {
  constructor(
    private readonly context: AppContext,
    private readonly member: MemberSession,
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
  ) {}

  private get db() {
    return this.context.db;
  }

  /** A run of the signed-in member; another member's or an unknown one is a 404 (API-5). */
  private ownRun(runId: string) {
    const run = isUuidV4(runId) ? repo.getRun(this.db, runId.toLowerCase()) : null;
    if (!run || run.memberId !== this.member.id) throw new HttpError(404, 'not_found', 'No such ranked run.');
    return run;
  }

  private activeOwnRun(runId: string) {
    const run = this.ownRun(runId);
    if (run.status !== 'active') throw new HttpError(409, 'run_not_active', 'This ranked run has ended.', { params: { status: run.status } });
    return run;
  }

  /** The mean score of the member's latest `ratingRuns` ended runs, leaving out `exceptRunId`; null without any. */
  private rating(ratingRuns: number, exceptRunId: string | null = null) {
    const runs = repo.endedRuns(this.db, this.member.id, ratingRuns + 1).filter((run) => run.id !== exceptRunId).slice(0, ratingRuns);
    return runs.length ? runs.reduce((sum, run) => sum + run.score, 0) / runs.length : null;
  }

  private view(run: repo.Run, ratingRuns: number): RankedRunView {
    const closed = repo.runAnswers(this.db, run.id).filter((answer) => answer.status !== 'pending' && answer.status !== 'served').length;
    let totals: RankedTotals | null = null;
    if (run.status !== 'active') {
      const after = this.rating(ratingRuns)!;
      const before = this.rating(ratingRuns, run.id);
      totals = {
        score: run.score,
        correctCount: run.correctCount,
        countedCount: run.countedCount,
        averageAnswerMs: run.answeredCount ? Math.round(run.answerMsTotal / run.answeredCount) : null,
        rating: roundRating(after),
        ratingChange: before === null ? null : roundRating(after) - roundRating(before),
      };
    }
    return {
      id: run.id,
      status: run.status,
      questionCount: run.questionCount,
      secondsPerQuestion: run.secondsPerQuestion,
      closedCount: closed,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      totals,
    };
  }

  /**
   * Ends a run: every question not closed yet expires, the streak bonus is
   * added, and the totals are stored. A run ended before its last question is
   * forfeited, and counts like any other.
   */
  private end(run: repo.Run, status: 'finished' | 'forfeited') {
    const now = this.now();
    for (const answer of repo.runAnswers(this.db, run.id)) {
      if (answer.status === 'pending' || answer.status === 'served') repo.closeAnswer(this.db, run.id, answer.position, { status: 'expired' }, now);
    }
    const answers = repo.runAnswers(this.db, run.id);
    const bonuses = streakBonuses(answers.map((answer) => (answer.status === 'left_out' ? null : answer.status === 'answered' && answer.correct)));
    const points = answers.map((answer, index) => ({ position: answer.position, points: answer.points + (answer.correct ? bonuses[index] : 0) }));
    const answered = answers.filter((answer) => answer.status === 'answered');
    repo.endRun(this.db, run.id, status, {
      score: points.reduce((sum, entry) => sum + entry.points, 0),
      correctCount: answers.filter((answer) => answer.correct).length,
      countedCount: answers.filter((answer) => answer.status !== 'left_out').length,
      answerMsTotal: answered.reduce((sum, answer) => sum + (Date.parse(answer.answeredAt!) - Date.parse(answer.servedAt!)), 0),
      answeredCount: answered.length,
      points,
    }, now);
  }

  /**
   * Starts a run, forfeiting the member's open one. `409 ranked_unavailable`
   * when the included categories have too few approved questions
   * (`too_few_questions`), or too few the member has not seen within the
   * cooldown (`cooldown`).
   */
  start(): RankedRunView {
    const settings = requireOpen(this.context);
    const open = repo.activeRun(this.db, this.member.id);
    if (open) this.end(open, 'forfeited');
    const count = settings['ranked.questionsPerRun'];
    const pool = repo.rankedPool(this.db);
    if (pool.length < count) {
      throw new HttpError(409, 'ranked_unavailable', 'The ranked categories have too few questions.', { params: { reason: 'too_few_questions', count } });
    }
    const since = new Date(this.now().getTime() - settings['ranked.cooldownDays'] * 86_400_000).toISOString();
    const shown = settings['ranked.cooldownDays'] > 0 ? repo.questionsShownSince(this.db, this.member.id, since) : new Set<string>();
    const available = pool.filter((question) => !shown.has(question.id));
    if (available.length < count) {
      throw new HttpError(409, 'ranked_unavailable', 'You have seen too many of the ranked questions recently; come back later.', { params: { reason: 'cooldown', count } });
    }
    const run = repo.insertRun(this.db, {
      memberId: this.member.id,
      secondsPerQuestion: settings['ranked.secondsPerQuestion'],
      questions: drawSpread(available, count, this.random),
    }, this.now());
    return this.view(run, settings['ranked.ratingRuns']);
  }

  /**
   * The current question: shown now if it was waiting (its time starts), or
   * shown again with its original deadline. Questions whose time ran out
   * expire, and questions unapproved or deleted meanwhile are left out. After
   * the last one the run finishes and `question` is null.
   */
  next(runId: string): { run: RankedRunView; question: RankedQuestionView | null } {
    const settings = requireOpen(this.context);
    const run = this.activeOwnRun(runId);
    const limitMs = run.secondsPerQuestion * 1000;
    for (const answer of repo.runAnswers(this.db, run.id)) {
      if (answer.status !== 'pending' && answer.status !== 'served') continue;
      const now = this.now();
      if (answer.status === 'served' && isLate(now.getTime() - Date.parse(answer.servedAt!), limitMs)) {
        repo.closeAnswer(this.db, run.id, answer.position, { status: 'expired' }, now);
        continue;
      }
      const question = answer.questionId ? getQuestion(this.db, answer.questionId) : null;
      if (!question || question.status !== 'approved') {
        repo.closeAnswer(this.db, run.id, answer.position, { status: 'left_out' }, now);
        continue;
      }
      if (answer.status === 'pending') repo.markServed(this.db, run.id, answer.position, now);
      const servedAt = answer.servedAt ?? now.toISOString();
      return {
        run: this.view(repo.getRun(this.db, run.id)!, settings['ranked.ratingRuns']),
        question: {
          position: answer.position,
          prompt: question.prompt,
          choices: shuffle(question.choices, this.random).map((choice) => ({ id: choice.id, text: choice.text })),
          multi: question.choices.filter((choice) => choice.isCorrect).length > 1,
          servedAt,
          deadline: new Date(Date.parse(servedAt) + limitMs).toISOString(),
          remainingMs: Math.max(0, Date.parse(servedAt) + limitMs - now.getTime()),
        },
      };
    }
    this.end(run, 'finished');
    return { run: this.view(repo.getRun(this.db, run.id)!, settings['ranked.ratingRuns']), question: null };
  }

  /**
   * Records the answer to the question being shown; the first answer is final.
   * The reply says only whether it arrived in time, never whether it is right.
   * The last answer finishes the run.
   */
  answer(runId: string, position: number, choiceIds: readonly string[]): { run: RankedRunView; late: boolean } {
    const settings = requireOpen(this.context);
    const run = this.activeOwnRun(runId);
    const current = repo.runAnswers(this.db, run.id).find((answer) => answer.status === 'pending' || answer.status === 'served');
    if (!current || current.position !== position || current.status !== 'served') {
      throw new HttpError(409, 'question_not_current', 'This is not the question being shown; ask for the next one.');
    }
    const now = this.now();
    const question = current.questionId ? getQuestion(this.db, current.questionId) : null;
    let late = false;
    if (!question || question.status !== 'approved') {
      repo.closeAnswer(this.db, run.id, position, { status: 'left_out' }, now);
    } else {
      const ids = choiceIds.map((id) => id.toLowerCase());
      const problems: FieldError[] = [];
      if (!ids.length) problems.push(fieldError('choiceIds', 'too_few', 'Choose at least one answer.', { min: 1 }));
      else if (new Set(ids).size !== ids.length) problems.push(fieldError('choiceIds', 'duplicate', 'Each answer is chosen once.'));
      else if (ids.some((id) => !question.choices.some((choice) => choice.id === id))) problems.push(fieldError('choiceIds', 'not_allowed', 'An answer does not belong to the question.'));
      if (problems.length) throw new HttpError(400, 'validation_failed', 'The answer is not valid.', { fields: problems });
      const limitMs = run.secondsPerQuestion * 1000;
      const elapsed = now.getTime() - Date.parse(current.servedAt!);
      late = isLate(elapsed, limitMs);
      const correct = !late && isCorrectSelection(ids, question.choices.filter((choice) => choice.isCorrect).map((choice) => choice.id));
      repo.closeAnswer(this.db, run.id, position, late
        ? { status: 'expired' }
        : { status: 'answered', answeredAt: now.toISOString(), correct, points: answerPoints(correct, elapsed, limitMs) }, now);
    }
    if (!repo.runAnswers(this.db, run.id).some((answer) => answer.status === 'pending' || answer.status === 'served')) this.end(run, 'finished');
    return { run: this.view(repo.getRun(this.db, run.id)!, settings['ranked.ratingRuns']), late };
  }

  /** A run of the member's: its progress while active, its totals once ended. */
  get(runId: string) {
    return this.view(this.ownRun(runId), values(this.context)['ranked.ratingRuns']);
  }

  /** The member's own rating, rank on the board, open run and latest ended runs. */
  mine() {
    const settings = values(this.context);
    const ratingRuns = settings['ranked.ratingRuns'];
    const runs = repo.endedRunCount(this.db, this.member.id);
    const rating = this.rating(ratingRuns);
    const latest = repo.endedRuns(this.db, this.member.id, ratingRuns);
    const board = sortedBoard(this.context, ratingRuns).filter((row) => row.runs >= RANKED_SCORING.provisionalRuns);
    const position = board.findIndex((row) => row.memberId === this.member.id);
    return {
      enabled: settings['ranked.enabled'],
      questionsPerRun: settings['ranked.questionsPerRun'],
      secondsPerQuestion: settings['ranked.secondsPerQuestion'],
      rating: rating === null ? null : roundRating(rating),
      runs,
      provisional: runs < RANKED_SCORING.provisionalRuns,
      accuracy: latest.length ? accuracyOf(latest.reduce((sum, run) => sum + run.correctCount, 0), latest.reduce((sum, run) => sum + run.countedCount, 0)) : null,
      rank: position >= 0 ? position + 1 : null,
      activeRunId: repo.activeRun(this.db, this.member.id)?.id ?? null,
      history: repo.endedRuns(this.db, this.member.id, RANKED_HISTORY).map((run) => ({
        id: run.id,
        status: run.status as 'finished' | 'forfeited',
        score: run.score,
        correctCount: run.correctCount,
        countedCount: run.countedCount,
        finishedAt: run.finishedAt!,
      })),
    };
  }
}

/** The Admin's view of which categories ranked runs draw from (#66). */
export function rankedCategories(context: AppContext) {
  return repo.rankedCategories(context.db);
}

/** Includes or leaves out categories; an unknown category is a field error. Returns the changed names. */
export function setRankedCategories(context: AppContext, changes: readonly { id: string; ranked: boolean }[]) {
  const known = new Map(repo.rankedCategories(context.db).map((category) => [category.id, category]));
  const problems: FieldError[] = [];
  const seen = new Set<string>();
  const normalized = changes.map((change, index) => {
    const id = change.id.toLowerCase();
    if (!isUuidV4(id) || !known.has(id)) problems.push(fieldError(`categories.${index}`, 'not_allowed', 'No such category.'));
    else if (seen.has(id)) problems.push(fieldError(`categories.${index}`, 'duplicate', 'Each category is listed once.'));
    seen.add(id);
    return { id, ranked: change.ranked };
  });
  if (problems.length) throw new HttpError(400, 'validation_failed', 'The categories are not valid.', { fields: problems });
  const changed = normalized.filter((change) => known.get(change.id)!.ranked !== change.ranked);
  repo.setCategoriesRanked(context.db, changed);
  return { categories: repo.rankedCategories(context.db), changed: changed.map((change) => ({ id: change.id, ranked: change.ranked })) };
}
