import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { MyRanked, RankedQuestion, RankedRun } from '../lib/api';
import { ApiError } from '../lib/client';
import { answerRankedQuestion, getMyRanked, nextRankedQuestion, startRankedRun } from '../lib/playerApi';
import { RANKED_SCORING, secondsLeft } from '../lib/ranked';
import { SHORTCUT_COUNT, shortcutIndex, shortcutKeys } from '../lib/quizSession';
import { formatTranslation } from '../translations';
import { useI18n } from './I18n';
import { ArrowRightIcon, RefreshIcon, TimerIcon, TrophyIcon } from './Icons';
import { useViewHeading } from './useViewHeading';

/**
 * Ranked mode (#66): the server shows one question at a time and keeps the
 * time; this screen only counts down, sends the first answer, and asks for the
 * next question. It never learns whether an answer was right; the totals come
 * when the run has ended.
 */

type Phase =
  | { status: 'intro' }
  | { status: 'loading' }
  | { status: 'question'; run: RankedRun; question: RankedQuestion; receivedAt: number }
  | { status: 'done'; run: RankedRun }
  | { status: 'error'; cause: unknown; retry(): void };

function RankedIntro({ mine, onStart, onResume, onBoard }: { mine: MyRanked | null; onStart(): void; onResume(runId: string): void; onBoard(): void }) {
  const { t, number } = useI18n();
  const heading = useViewHeading('ranked:intro');
  return (
    <section className="player-section ranked-intro" aria-labelledby="ranked-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{t.ranked.eyebrow}</p>
          <h1 id="ranked-heading" ref={heading} tabIndex={-1}>{t.ranked.title}</h1>
        </div>
        {mine && (
          <p className="section-heading-meta">
            {mine.rating === null ? t.ranked.noRating : formatTranslation(t.ranked.rating, { rating: number(mine.rating) })}
          </p>
        )}
      </div>
      {mine && <p>{formatTranslation(t.ranked.intro, { count: number(mine.questionsPerRun), seconds: number(mine.secondsPerQuestion) })}</p>}
      <ul className="ranked-rules">
        <li>{t.ranked.ruleFinal}</li>
        <li>{t.ranked.ruleSecret}</li>
        <li>{t.ranked.ruleSpeed}</li>
        <li>{t.ranked.ruleCounts}</li>
      </ul>
      {mine?.provisional && mine.runs > 0 && (
        <p className="ranked-note">{formatTranslation(t.ranked.provisional, { count: number(RANKED_SCORING.provisionalRuns - mine.runs) })}</p>
      )}
      {mine?.activeRunId ? (
        <>
          <p className="admin-notice">{t.ranked.resumeText}</p>
          <div className="form-actions">
            <button className="button button-primary button-with-icon" type="button" onClick={() => onResume(mine.activeRunId!)}><ArrowRightIcon />{t.ranked.resume}</button>
            <button className="button button-secondary" type="button" onClick={onStart}>{t.ranked.startNew}</button>
          </div>
        </>
      ) : (
        <div className="form-actions">
          <button className="button button-primary button-with-icon" type="button" disabled={!mine} onClick={onStart}><TimerIcon />{t.ranked.start}</button>
          <button className="button button-secondary button-with-icon" type="button" onClick={onBoard}><TrophyIcon />{t.ranked.boardLink}</button>
        </div>
      )}
    </section>
  );
}

function RankedQuestionView({ run, question, receivedAt, onAnswer, onTimeout }: {
  run: RankedRun;
  question: RankedQuestion;
  receivedAt: number;
  onAnswer(choiceIds: string[]): Promise<void>;
  onTimeout(): void;
}) {
  const { t, number } = useI18n();
  const id = useId();
  const heading = useViewHeading(`ranked:${run.id}:${question.position}`);
  const [selected, setSelected] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const left = secondsLeft(question.remainingMs, receivedAt, now);
  const total = run.secondsPerQuestion;

  useEffect(() => {
    if (sending) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [sending]);

  const submit = useCallback(async (choiceIds: string[]) => {
    if (sending || !choiceIds.length) return;
    setSending(true);
    try {
      await onAnswer(choiceIds);
    } finally {
      setSending(false);
    }
  }, [onAnswer, sending]);

  // Time's up: a chosen answer still goes (within the server's allowance, without a speed bonus); otherwise the question expires.
  const timedOut = useRef(false);
  useEffect(() => {
    if (left > 0 || timedOut.current || sending) return;
    timedOut.current = true;
    if (selected.length) void submit(selected);
    else onTimeout();
  }, [left, selected, sending, submit, onTimeout]);

  function choose(choiceId: string, checked: boolean) {
    setSelected((current) => (question.multi ? (checked ? [...current.filter((idValue) => idValue !== choiceId), choiceId] : current.filter((idValue) => idValue !== choiceId)) : (checked ? [choiceId] : [])));
  }

  // #68: A–F or 1–6 pick an answer here too.
  const latest = useRef({ selected, sending, question });
  useEffect(() => { latest.current = { selected, sending, question }; });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('textarea, select, [contenteditable="true"], input:not([type="radio"]):not([type="checkbox"])')) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const current = latest.current;
      if (current.sending) return;
      const index = shortcutIndex(event.key, current.question.choices.length);
      if (index === null) return;
      event.preventDefault();
      const choiceId = current.question.choices[index].id;
      setSelected((chosen) => (current.question.multi ? (chosen.includes(choiceId) ? chosen.filter((value) => value !== choiceId) : [...chosen, choiceId]) : [choiceId]));
      inputs.current[index]?.focus();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(selected);
  }

  return (
    <section className="quiz-panel ranked-panel" aria-labelledby={`${id}-prompt`}>
      <div className="quiz-meta">
        <span>{t.ranked.title}</span>
        <span>{formatTranslation(t.quiz.progress, { number: number(question.position + 1), total: number(run.questionCount) })}</span>
      </div>
      <div className="ranked-timer">
        <TimerIcon />
        <span aria-hidden="true">{formatTranslation(t.ranked.timeLeft, { seconds: number(left) })}</span>
        <progress className="quiz-progress" max={total} value={left} aria-label={formatTranslation(t.ranked.timeLow, { seconds: number(left) })} />
      </div>
      {/* Announced once, near the end, not every second. */}
      <p className="sr-only" role="status">{left <= 5 && left > 0 ? formatTranslation(t.ranked.timeLow, { seconds: number(5) }) : ''}</p>
      <p className="selection-hint" id={`${id}-hint`}>{question.multi ? t.quiz.selectAll : t.quiz.selectOne}</p>
      <h1 className="question-prompt" id={`${id}-prompt`} ref={heading} tabIndex={-1} lang="en">{question.prompt}</h1>
      <form onSubmit={onSubmit} noValidate>
        <fieldset className="answer-fieldset" aria-describedby={`${id}-hint`} disabled={sending}>
          <legend className="sr-only">{t.quiz.answers}</legend>
          <ol className="answer-list">
            {question.choices.map((choice, index) => (
              <li key={choice.id}>
                <label className="answer">
                  <input
                    ref={(element) => { inputs.current[index] = element; }}
                    aria-keyshortcuts={index < SHORTCUT_COUNT ? shortcutKeys(index) : undefined}
                    type={question.multi ? 'checkbox' : 'radio'}
                    name={`ranked-${run.id}-${question.position}`}
                    value={choice.id}
                    checked={selected.includes(choice.id)}
                    onChange={(event) => choose(choice.id, event.target.checked)}
                  />
                  <span className="answer-marker" aria-hidden="true">{String.fromCharCode(65 + index)}</span>
                  <span className="answer-text" lang="en">{choice.text}</span>
                </label>
              </li>
            ))}
          </ol>
        </fieldset>
        <div className="quiz-actions">
          <span />
          <button className="button button-primary button-with-icon quiz-submit" type="submit" disabled={sending || !selected.length}>
            {sending ? t.ranked.sending : t.ranked.submit}
            {!sending && <ArrowRightIcon />}
          </button>
        </div>
      </form>
    </section>
  );
}

function RankedResults({ run, onAgain, onBoard }: { run: RankedRun; onAgain(): void; onBoard(): void }) {
  const { t, number } = useI18n();
  const heading = useViewHeading(`ranked:done:${run.id}`);
  const totals = run.totals!;
  const change = totals.ratingChange;
  return (
    <section className="player-section ranked-results" aria-labelledby="ranked-results-heading">
      <p className="eyebrow">{run.status === 'forfeited' ? t.ranked.forfeitedEyebrow : t.ranked.resultsEyebrow}</p>
      <h1 id="ranked-results-heading" ref={heading} tabIndex={-1}>{t.ranked.resultsTitle}</h1>
      <dl className="category-counts ranked-totals">
        <div><dt>{t.ranked.score}</dt><dd>{number(totals.score)}</dd></div>
        <div><dt>{t.ranked.correct}</dt><dd>{formatTranslation(t.ranked.correctValue, { correct: number(totals.correctCount), total: number(totals.countedCount) })}</dd></div>
        <div>
          <dt>{t.ranked.averageTime}</dt>
          <dd>{totals.averageAnswerMs === null ? t.ranked.noAverage : formatTranslation(t.ranked.averageValue, { seconds: number(Math.round(totals.averageAnswerMs / 100) / 10) })}</dd>
        </div>
        <div><dt>{t.ranked.ratingLabel}</dt><dd>{number(totals.rating)}</dd></div>
        <div><dt>{t.ranked.ratingChange}</dt><dd>{change === null ? t.ranked.firstRating : `${change > 0 ? '+' : ''}${number(change)}`}</dd></div>
      </dl>
      <div className="form-actions">
        <button className="button button-primary button-with-icon" type="button" onClick={onAgain}><TimerIcon />{t.ranked.playAgain}</button>
        <button className="button button-secondary button-with-icon" type="button" onClick={onBoard}><TrophyIcon />{t.ranked.boardLink}</button>
      </div>
    </section>
  );
}

/**
 * `?page=ranked`: the intro with the member's rating, a run, and its totals.
 * `onActive` tells the app whether a run is being played, so leaving asks
 * first (#67).
 */
export function RankedPage({ onActive, onBoard }: { onActive(active: boolean): void; onBoard(): void }) {
  const { t, error } = useI18n();
  const [phase, setPhase] = useState<Phase>({ status: 'intro' });
  const [mine, setMine] = useState<MyRanked | null>(null);
  const [status, setStatus] = useState('');

  const loadMine = useCallback(() => {
    getMyRanked().then(setMine, (cause: unknown) => setPhase({ status: 'error', cause, retry: () => { setPhase({ status: 'intro' }); loadMine(); } }));
  }, []);
  useEffect(() => { loadMine(); }, [loadMine]);

  const active = phase.status === 'question' || phase.status === 'loading';
  useEffect(() => { onActive(active); }, [active, onActive]);
  useEffect(() => () => onActive(false), [onActive]);

  const fetchNext = useCallback(async (runId: string) => {
    setPhase({ status: 'loading' });
    try {
      const step = await nextRankedQuestion(runId);
      if (step.question) setPhase({ status: 'question', run: step.run, question: step.question, receivedAt: Date.now() });
      else { setPhase({ status: 'done', run: step.run }); loadMine(); }
    } catch (cause) {
      setPhase({ status: 'error', cause, retry: () => void fetchNext(runId) });
    }
  }, [loadMine]);

  const start = useCallback(async () => {
    setStatus('');
    setPhase({ status: 'loading' });
    try {
      const { run } = await startRankedRun();
      await fetchNext(run.id);
    } catch (cause) {
      setPhase({ status: 'error', cause, retry: () => { setPhase({ status: 'intro' }); loadMine(); } });
    }
  }, [fetchNext, loadMine]);

  const answer = useCallback(async (run: RankedRun, question: RankedQuestion, choiceIds: string[]) => {
    try {
      const result = await answerRankedQuestion(run.id, question.position, choiceIds);
      setStatus(result.late ? t.ranked.late : t.ranked.received);
      if (result.run.status === 'active') await fetchNext(run.id);
      else { setPhase({ status: 'done', run: result.run }); loadMine(); }
    } catch (cause) {
      // The answer already arrived, or the question moved on: the server knows where the run is.
      if (cause instanceof ApiError && (cause.code === 'question_not_current' || cause.code === 'run_not_active')) await fetchNext(run.id);
      else setPhase({ status: 'error', cause, retry: () => void answer(run, question, choiceIds) });
    }
  }, [fetchNext, loadMine, t]);

  const timeout = useCallback((runId: string) => {
    setStatus(t.ranked.timeUp);
    // The server expires a question once its allowance has passed too.
    window.setTimeout(() => void fetchNext(runId), RANKED_SCORING.graceMs + 500);
  }, [fetchNext, t]);

  let content;
  if (phase.status === 'intro') content = <RankedIntro mine={mine} onStart={() => void start()} onResume={(runId) => void fetchNext(runId)} onBoard={onBoard} />;
  else if (phase.status === 'loading') content = <section className="status-panel" role="status"><span className="loader" aria-hidden="true" /><p>{t.ranked.loading}</p></section>;
  else if (phase.status === 'question') {
    content = (
      <RankedQuestionView
        key={`${phase.run.id}:${phase.question.position}:${phase.receivedAt}`}
        run={phase.run}
        question={phase.question}
        receivedAt={phase.receivedAt}
        onAnswer={(choiceIds) => answer(phase.run, phase.question, choiceIds)}
        onTimeout={() => timeout(phase.run.id)}
      />
    );
  } else if (phase.status === 'done') content = <RankedResults run={phase.run} onAgain={() => void start()} onBoard={onBoard} />;
  else {
    const reason = phase.cause instanceof ApiError && phase.cause.code === 'ranked_unavailable' ? phase.cause.params?.reason : undefined;
    content = (
      <section className="status-panel" role="alert">
        <p className="error-note">{reason === 'cooldown' ? t.ranked.cooldown : reason === 'too_few_questions' ? t.ranked.tooFew : error(phase.cause)}</p>
        <button className="button button-primary button-with-icon" type="button" onClick={phase.retry}><RefreshIcon />{t.common.retry}</button>
      </section>
    );
  }
  return (
    <div className="ranked-page">
      <p className="sr-only" role="status">{status}</p>
      {content}
    </div>
  );
}
