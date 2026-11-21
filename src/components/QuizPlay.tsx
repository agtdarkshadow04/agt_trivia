import { type FormEvent, useEffect, useId, useRef } from 'react';
import type { PublicCategory, QuizLength } from '../lib/api';
import { availableLengths } from '../lib/quiz';
import { choiceState, currentQuestion, isMultiAnswer, quizResult, reviewAnswers, SHORTCUT_COUNT, shortcutIndex, shortcutKeys, type ChoiceState, type QuizSession } from '../lib/quizSession';
import { formatTranslation } from '../translations';
import { useI18n } from './I18n';
import { ArrowLeftIcon, ArrowRightIcon, CheckCircleIcon, RotateCcwIcon, XCircleIcon } from './Icons';
import { ReportButton } from './QuestionReports';
import { useViewHeading } from './useViewHeading';

/** The way back to the categories, above every view of a category. */
export function BackToCategories({ onBack, children }: { onBack(): void; children?: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="quiz-bar">
      <button className="button button-secondary button-with-icon" type="button" onClick={onBack}><ArrowLeftIcon />{t.quiz.backToCategories}</button>
      {children}
    </div>
  );
}

/** Short, long or full (#16): the lengths come from `quiz.shortLength` and `quiz.longLength`; only those that differ are offered (#43). */
export function LengthChoice({ category, shortLength, longLength, onChoose }: {
  category: PublicCategory;
  shortLength: number;
  longLength: number;
  onChoose(length: QuizLength): void;
}) {
  const { t, number } = useI18n();
  const heading = useViewHeading(`length:${category.id}`);
  const all: Record<QuizLength, { name: string; meta: string; text: string }> = {
    short: { name: t.quiz.short, meta: formatTranslation(t.quiz.upTo, { count: number(shortLength) }), text: t.quiz.shortText },
    long: { name: t.quiz.long, meta: formatTranslation(t.quiz.upTo, { count: number(longLength) }), text: t.quiz.longText },
    all: { name: t.quiz.full, meta: formatTranslation(t.quiz.allOf, { count: number(category.questionCount) }), text: t.quiz.fullText },
  };
  // #43: only the lengths that differ; a short quiz of a 6-question category would be the full one.
  const choices = availableLengths(category.questionCount, shortLength, longLength).map((length) => ({ length, ...all[length] }));
  return (
    <section className="player-section" aria-labelledby="length-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow" lang="en">{category.name}</p>
          <h1 id="length-heading" ref={heading} tabIndex={-1}>{t.quiz.chooseLength}</h1>
        </div>
        <p className="section-heading-meta">{formatTranslation(t.quiz.available, { count: number(category.questionCount) })}</p>
      </div>
      <ol className="choice-grid">
        {choices.map((choice, index) => (
          <li key={choice.length}>
            <button className="choice-card" type="button" onClick={() => onChoose(choice.length)}>
              <span className="choice-card-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <span className="choice-card-body">
                <span className="choice-card-meta">{choice.meta}</span>
                <span className="choice-card-name">{choice.name}</span>
                <span className="choice-card-text">{choice.text}</span>
              </span>
              <ArrowRightIcon className="choice-card-arrow" />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** A11Y-1: an answer's state is an icon and words, never colour alone. */
function AnswerState({ state }: { state: ChoiceState | null }) {
  const { t } = useI18n();
  if (state === null || state === 'other') return null;
  const correct = state !== 'wrong-chosen';
  const label = state === 'correct-chosen' ? t.quiz.stateCorrectChosen : state === 'correct-missed' ? t.quiz.stateCorrectMissed : t.quiz.stateWrongChosen;
  return (
    <span className={`answer-state ${correct ? 'answer-state-correct' : 'answer-state-wrong'}`}>
      {correct ? <CheckCircleIcon /> : <XCircleIcon />}{label}
    </span>
  );
}

const answerClass: Record<ChoiceState, string> = {
  'correct-chosen': 'answer-correct',
  'correct-missed': 'answer-correct',
  'wrong-chosen': 'answer-wrong',
  other: 'answer-muted',
};

/**
 * One question (#16): radio buttons for a single-answer question, checkboxes
 * for a multi-answer one; Lock answer grades it and shows the feedback, then
 * Next question (or View results) moves on.
 */
export function QuestionView({ category, session, reportable = false, onChoose, onLock, onNext }: {
  category: PublicCategory;
  session: QuizSession;
  /** A signed-in member can report a problem with the question (#46). */
  reportable?: boolean;
  onChoose(choiceId: string, checked: boolean): void;
  onLock(): void;
  onNext(): void;
}) {
  const { t, number } = useI18n();
  const id = useId();
  const question = currentQuestion(session)!;
  const heading = useViewHeading(`question:${session.index}`);
  const multi = isMultiAnswer(question);
  const total = session.questions.length;
  const last = session.index === total - 1;
  const correctTexts = question.choices.filter((choice) => question.correctChoiceIds.includes(choice.id)).map((choice) => choice.text);
  // Locking disables the answers, which would drop the keyboard focus: it moves on to Next question (A11Y-5).
  const submitButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (session.locked) submitButton.current?.focus();
  }, [session.locked]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (session.locked) onNext();
    else onLock();
  }

  // #68: A–F or 1–6 picks an answer (toggles it for a multi-answer question) and focuses it, so screen readers
  // announce it; Enter still locks the answer through the form.
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const latest = useRef({ session, onChoose });
  useEffect(() => { latest.current = { session, onChoose }; });
  useEffect(() => {
    if (session.locked) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('textarea, select, [contenteditable="true"], input:not([type="radio"]):not([type="checkbox"])')) return;
      // The report dialog, the settings or a leave confirmation is open.
      if (document.querySelector('[aria-modal="true"]')) return;
      const { session: current, onChoose: choose } = latest.current;
      const question = currentQuestion(current);
      if (!question || current.locked) return;
      const index = shortcutIndex(event.key, question.choices.length);
      if (index === null) return;
      event.preventDefault();
      const choiceId = question.choices[index].id;
      choose(choiceId, isMultiAnswer(question) ? !current.selected.includes(choiceId) : true);
      inputs.current[index]?.focus();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [session.locked, session.index]);
  const shownChoices = Math.min(question.choices.length, SHORTCUT_COUNT);

  return (
    <section className="quiz-panel" aria-labelledby={`${id}-prompt`}>
      <div className="quiz-meta">
        <span>{category.shortName}</span>
        <span>{formatTranslation(t.quiz.progress, { number: number(session.index + 1), total: number(total) })}</span>
      </div>
      <progress className="quiz-progress" max={total} value={session.index + 1} aria-label={t.quiz.progressLabel} />
      <p className="selection-hint" id={`${id}-hint`}>{multi ? t.quiz.selectAll : t.quiz.selectOne}</p>
      {!session.locked && (
        <p className="shortcut-hint">
          {formatTranslation(t.quiz.shortcutHint, { letters: `A–${String.fromCharCode(64 + shownChoices)}`, numbers: `1–${shownChoices}` })}
        </p>
      )}
      <h1 className="question-prompt" id={`${id}-prompt`} ref={heading} tabIndex={-1} lang="en">{question.prompt}</h1>
      <form onSubmit={submit} noValidate>
        <fieldset className="answer-fieldset" aria-describedby={`${id}-hint`}>
          <legend className="sr-only">{t.quiz.answers}</legend>
          <ol className="answer-list">
            {question.choices.map((choice, index) => {
              const state = choiceState(session, choice.id);
              return (
                <li key={choice.id}>
                  <label className={`answer ${state ? answerClass[state] : ''}`.trim()}>
                    <input
                      ref={(element) => { inputs.current[index] = element; }}
                      aria-keyshortcuts={index < SHORTCUT_COUNT ? shortcutKeys(index) : undefined}
                      type={multi ? 'checkbox' : 'radio'}
                      name={`answer-${question.id}`}
                      value={choice.id}
                      checked={session.selected.includes(choice.id)}
                      disabled={session.locked}
                      onChange={(event) => onChoose(choice.id, event.target.checked)}
                    />
                    <span className="answer-marker" aria-hidden="true">{String.fromCharCode(65 + index)}</span>
                    <span className="answer-text" lang="en">{choice.text}</span>
                    <AnswerState state={state} />
                  </label>
                </li>
              );
            })}
          </ol>
        </fieldset>
        <div role="status" aria-live="polite">
          {session.locked && (
            <div className={`feedback ${session.lastCorrect ? 'feedback-correct' : 'feedback-wrong'}`}>
              {session.lastCorrect ? <CheckCircleIcon /> : <XCircleIcon />}
              <div>
                <strong>{session.lastCorrect ? t.quiz.feedbackCorrect : t.quiz.feedbackWrong}</strong>
                <p>
                  {session.lastCorrect
                    ? t.quiz.scoreUpdated
                    : formatTranslation(correctTexts.length > 1 ? t.quiz.correctAnswers : t.quiz.correctAnswer, { answers: correctTexts.join(', ') })}
                </p>
              </div>
            </div>
          )}
        </div>
        <div className="quiz-actions">
          <span className="quiz-credit">
            {question.authorCredit ? formatTranslation(t.quiz.submittedBy, { author: question.authorCredit }) : t.quiz.allianceArchive}
          </span>
          <button ref={submitButton} className="button button-primary button-with-icon quiz-submit" type="submit" disabled={!session.locked && session.selected.length === 0}>
            {session.locked ? (last ? t.quiz.viewResults : t.quiz.nextQuestion) : t.quiz.lockAnswer}
            {session.locked && <ArrowRightIcon />}
          </button>
        </div>
      </form>
      {reportable && <div className="quiz-report"><ReportButton questionId={question.id} prompt={question.prompt} /></div>}
    </section>
  );
}

/** The score as a ring (an SVG arc, no inline styles under the CSP), with the score in words for screen readers. */
function ScoreRing({ score, total, percent }: { score: number; total: number; percent: number }) {
  const { t, number, percent: formatPercent } = useI18n();
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="score-ring" role="img" aria-label={formatTranslation(t.quiz.scoreLabel, { score: number(score), total: number(total), percent: formatPercent(percent) })}>
      <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
        <circle className="score-ring-track" cx="60" cy="60" r={radius} />
        <circle
          className="score-ring-value"
          cx="60"
          cy="60"
          r={radius}
          strokeDasharray={`${(circumference * percent) / 100} ${circumference}`}
          transform="rotate(-90 60 60)"
        />
      </svg>
      <span className="score-ring-text" aria-hidden="true">
        <strong>{number(score)}<small>/{number(total)}</small></strong>
        <span>{t.quiz.correct}</span>
      </span>
    </div>
  );
}

/**
 * The end-of-quiz review (#44): every question in the order played, with the
 * player's answer, the correct one, and whether it was right in an icon and
 * words (A11Y-1). Closed until opened; a native disclosure, so the keyboard
 * and screen readers work without extra code.
 */
function AnswerReview({ session, reportable }: { session: QuizSession; reportable: boolean }) {
  const { t, number } = useI18n();
  const items = reviewAnswers(session);
  if (!items.length) return null;
  return (
    <details className="answer-review">
      <summary>{t.quiz.reviewAnswers}</summary>
      <ol className="review-list">
        {items.map((item, index) => (
          <li key={item.questionId} className="review-item">
            <p className="review-item-meta">{formatTranslation(t.quiz.progress, { number: number(index + 1), total: number(items.length) })}</p>
            <p className="review-item-prompt" lang="en">{item.prompt}</p>
            <span className={`answer-state ${item.right ? 'answer-state-correct' : 'answer-state-wrong'}`}>
              {item.right ? <CheckCircleIcon /> : <XCircleIcon />}{item.right ? t.quiz.stateCorrectChosen : t.quiz.stateWrongChosen}
            </span>
            <p>{formatTranslation(t.quiz.reviewChosen, { answers: item.chosen.join(', ') })}</p>
            {!item.right && <p>{formatTranslation(item.correct.length > 1 ? t.quiz.correctAnswers : t.quiz.correctAnswer, { answers: item.correct.join(', ') })}</p>}
            {reportable && <div><ReportButton questionId={item.questionId} prompt={item.prompt} /></div>}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** The results (#16): score, percentage and rank, then replay or choose another category, and the review (#44). */
export function Results({ category, session, reportable = false, onReplay, onAnother, children }: {
  category: PublicCategory;
  session: QuizSession;
  /** A signed-in member can report a problem with each question (#46). */
  reportable?: boolean;
  onReplay(): void;
  onAnother(): void;
  /** Whether the result is saved to a member's history (#21). */
  children?: React.ReactNode;
}) {
  const { t, percent: formatPercent } = useI18n();
  const heading = useViewHeading('results');
  const result = quizResult(session);
  return (
    <section className="results-panel" aria-labelledby="results-heading">
      <ScoreRing score={result.score} total={result.total} percent={result.percent} />
      <div className="results-copy">
        <p className="eyebrow">{t.quiz.resultsEyebrow}</p>
        <h1 id="results-heading" ref={heading} tabIndex={-1}>{t.ranks[result.rank]}</h1>
        <p>{formatTranslation(t.quiz.resultText, { category: category.name, percent: formatPercent(result.percent) })}</p>
        {children}
        <div className="form-actions">
          <button className="button button-primary button-with-icon" type="button" onClick={onReplay}><RotateCcwIcon />{t.quiz.replay}</button>
          <button className="button button-secondary" type="button" onClick={onAnother}>{t.quiz.chooseAnother}</button>
        </div>
      </div>
      <AnswerReview session={session} reportable={reportable} />
    </section>
  );
}
