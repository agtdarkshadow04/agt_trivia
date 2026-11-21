import { useCallback, useEffect, useRef, useState } from 'react';
import type { CategoryStats, MemberSession, QuizLength, QuizResultRecord } from '../lib/api';
import { clearResults, getMemberStats, listResults, saveResult } from '../lib/playerApi';
import { pointsAttribute, trendPoints } from '../lib/trend';
import { formatTranslation } from '../translations';
import { ConfirmDialog } from './Dialog';
import { SelectField } from './Field';
import { useI18n } from './I18n';
import { LogInIcon, RefreshIcon, TrashIcon } from './Icons';
import { MyRankedSummary } from './RankedBoard';
import { useViewHeading } from './useViewHeading';

/**
 * Member score history (#21). `SaveResult` sits on the results screen: for a
 * signed-in member it sends the answers at once (the server grades them) and
 * says so in a live region, with a retry; anonymous players are invited to
 * sign in. `ScoresPage` is `?page=scores`: the member's stats per category and
 * their history, which only they can see and clear.
 */

type SaveState =
  | { status: 'saving' }
  | { status: 'saved'; skipped: number }
  | { status: 'error'; cause: unknown };

export function SaveResult({ member, categoryId, length, attemptToken, answers, onSignIn, onSaved }: {
  member: MemberSession | null | undefined;
  categoryId: string;
  length: QuizLength;
  /** The drawn quiz's signed attempt (#45): a retry after a lost answer saves nothing twice. */
  attemptToken: string;
  answers: readonly { questionId: string; choiceIds: readonly string[] }[];
  onSignIn(): void;
  /** After the result is stored, so the player's personal bests can be read again (#69). */
  onSaved?(): void;
}) {
  const { t, error, number } = useI18n();
  const saved = useRef(onSaved);
  useEffect(() => { saved.current = onSaved; });
  const [state, setState] = useState<SaveState>({ status: 'saving' });
  // One save per finished quiz, even when React runs the effect twice.
  const sent = useRef<typeof answers | null>(null);

  const save = useCallback(async () => {
    setState({ status: 'saving' });
    try {
      const result = await saveResult(categoryId, length, attemptToken, answers);
      setState({ status: 'saved', skipped: result.skippedQuestionIds.length });
      saved.current?.();
    } catch (cause) {
      setState({ status: 'error', cause });
    }
  }, [categoryId, length, attemptToken, answers]);

  useEffect(() => {
    if (!member || sent.current === answers || answers.length === 0) return;
    sent.current = answers;
    void save();
  }, [member, answers, save]);

  if (member === undefined) return null;
  if (member === null) {
    return (
      <div className="result-save">
        <p>{t.scores.signInPrompt}</p>
        <button className="button button-secondary button-with-icon" type="button" onClick={onSignIn}><LogInIcon />{t.layout.signIn}</button>
      </div>
    );
  }
  return (
    <div className="result-save">
      <div role="status">
        {state.status === 'saving' && <p>{t.scores.saving}</p>}
        {state.status === 'saved' && (
          <p className="success-note">{state.skipped ? formatTranslation(t.scores.savedSkipped, { count: number(state.skipped) }) : t.scores.saved}</p>
        )}
      </div>
      {state.status === 'error' && (
        <div role="alert">
          <p className="error-note">{formatTranslation(t.scores.saveFailed, { reason: error(state.cause) })}</p>
          <button className="button button-secondary button-with-icon" type="button" onClick={() => void save()}><RefreshIcon />{t.common.retry}</button>
        </div>
      )}
    </div>
  );
}

/**
 * A category's latest results as a small line (#72): inline SVG like the score
 * ring, no inline styles (CSP), with the values in words for screen readers.
 */
function Trend({ percents }: { percents: readonly number[] }) {
  const { t, number, percent } = useI18n();
  const points = trendPoints(percents);
  if (!points.length) return null;
  const label = formatTranslation(t.scores.trendLabel, { count: number(percents.length), first: percent(percents[0]), last: percent(percents.at(-1)!) });
  const end = points.at(-1)!;
  return (
    <div className="score-trend">
      <svg className="score-trend-line" viewBox="0 0 120 36" role="img" aria-label={label} focusable="false">
        <line className="score-trend-axis" x1="3" x2="117" y1="33" y2="33" />
        <polyline className="score-trend-path" points={pointsAttribute(points)} />
        <circle className="score-trend-end" cx={end.x} cy={end.y} r="2.5" />
      </svg>
      <span className="score-trend-latest">{formatTranslation(t.scores.latest, { percent: percent(percents.at(-1)!) })}</span>
    </div>
  );
}

type Loaded<T> = { status: 'loading' } | { status: 'error'; cause: unknown } | { status: 'ready'; value: T };

export function ScoresPage({ onCleared }: { /** After the history is cleared (#69). */ onCleared?(): void } = {}) {
  const { t, error, number, percent, dateTime, date } = useI18n();
  const heading = useViewHeading('scores');
  const [stats, setStats] = useState<Loaded<CategoryStats[]>>({ status: 'loading' });
  const [history, setHistory] = useState<Loaded<{ items: QuizResultRecord[]; nextCursor: string | null }>>({ status: 'loading' });
  const [categoryId, setCategoryId] = useState('');
  const [more, setMore] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const lengths: Record<QuizLength, string> = { short: t.quiz.short, long: t.quiz.long, all: t.quiz.full };

  const loadStats = useCallback(async () => {
    try {
      setStats({ status: 'ready', value: await getMemberStats() });
    } catch (cause) {
      setStats({ status: 'error', cause });
    }
  }, []);
  const loadHistory = useCallback(async () => {
    setHistory({ status: 'loading' });
    try {
      setHistory({ status: 'ready', value: await listResults({ categoryId: categoryId || undefined }) });
    } catch (cause) {
      setHistory({ status: 'error', cause });
    }
  }, [categoryId]);
  useEffect(() => { void loadStats(); }, [loadStats]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);

  async function loadMore() {
    if (history.status !== 'ready' || !history.value.nextCursor) return;
    setMore(true);
    try {
      const page = await listResults({ categoryId: categoryId || undefined, cursor: history.value.nextCursor });
      setHistory({ status: 'ready', value: { items: [...history.value.items, ...page.items], nextCursor: page.nextCursor } });
    } catch (cause) {
      setActionError(error(cause));
    } finally {
      setMore(false);
    }
  }

  async function confirmClear() {
    setBusy(true);
    try {
      await clearResults();
      setClearing(false);
      setCategoryId('');
      setMessage(t.scores.cleared);
      setActionError('');
      void loadStats();
      onCleared?.();
      void loadHistory();
    } catch (cause) {
      setClearing(false);
      setActionError(error(cause));
    } finally {
      setBusy(false);
    }
  }

  const empty = stats.status === 'ready' && stats.value.length === 0 && history.status === 'ready' && history.value.items.length === 0 && !categoryId;

  return (
    <section className="player-section" aria-labelledby="scores-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{t.scores.eyebrow}</p>
          <h1 id="scores-title" ref={heading} tabIndex={-1}>{t.scores.title}</h1>
        </div>
        {!empty && (
          <button className="button button-danger button-with-icon" type="button" aria-haspopup="dialog" aria-expanded={clearing} onClick={() => { setMessage(''); setClearing(true); }}>
            <TrashIcon />{t.scores.clear}
          </button>
        )}
      </div>
      <p className="workshop-intro">{t.scores.text}</p>
      <div role="status" className="workshop-status">{message && <p className="success-note">{message}</p>}</div>
      {actionError && <p className="error-note" role="alert">{actionError}</p>}
      {/* #66: Ranked mode's standing, whether or not the member has practice results. */}
      <MyRankedSummary />
      {empty && <p className="empty-note">{t.scores.empty}</p>}

      {!empty && (
        <>
          <h2 className="scores-heading">{t.scores.statsTitle}</h2>
          {stats.status === 'loading' && <p className="loading-note" role="status">{t.scores.loading}</p>}
          {stats.status === 'error' && <p className="error-note" role="alert">{error(stats.cause)}</p>}
          {stats.status === 'ready' && (
            <ul className="question-list">
              {stats.value.map((entry) => (
                <li key={entry.categoryId}>
                  <article className="question-card" aria-labelledby={`stats-${entry.categoryId}`}>
                    <h3 id={`stats-${entry.categoryId}`} className="question-card-prompt" lang="en">{entry.categoryName}</h3>
                    <dl className="category-counts">
                      <div><dt>{t.scores.plays}</dt><dd>{number(entry.plays)}</dd></div>
                      <div><dt>{t.scores.best}</dt><dd>{percent(entry.bestPercent)}</dd></div>
                      <div><dt>{t.scores.average}</dt><dd>{percent(entry.averagePercent)}</dd></div>
                      <div><dt>{t.scores.lastPlayed}</dt><dd>{date(entry.lastPlayedAt)}</dd></div>
                    </dl>
                    <Trend percents={entry.recentPercents} />
                  </article>
                </li>
              ))}
            </ul>
          )}

          <h2 className="scores-heading">{t.scores.historyTitle}</h2>
          {stats.status === 'ready' && stats.value.length > 0 && (
            <div className="workshop-filters">
              <SelectField label={t.fields.categoryId} value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
                <option value="">{t.scores.allCategories}</option>
                {stats.value.map((entry) => <option key={entry.categoryId} value={entry.categoryId} lang="en">{entry.categoryName}</option>)}
              </SelectField>
            </div>
          )}
          {history.status === 'loading' && <p className="loading-note" role="status">{t.scores.loading}</p>}
          {history.status === 'error' && (
            <div role="alert">
              <p className="error-note">{error(history.cause)}</p>
              <button className="button button-secondary" type="button" onClick={() => void loadHistory()}>{t.common.retry}</button>
            </div>
          )}
          {history.status === 'ready' && (
            <ol className="score-history">
              {history.value.items.map((result) => (
                <li key={result.id} className="score-entry">
                  <span className="score-entry-category" lang="en">{result.categoryName}</span>
                  <span>{lengths[result.length]}</span>
                  <span className="score-entry-score">{formatTranslation(t.scores.entryScore, { score: number(result.score), total: number(result.total), percent: percent(result.percent) })}</span>
                  <time dateTime={result.finishedAt}>{dateTime(result.finishedAt)}</time>
                </li>
              ))}
            </ol>
          )}
          {history.status === 'ready' && history.value.nextCursor && (
            <div className="form-actions">
              <button className="button button-secondary" type="button" disabled={more} onClick={() => void loadMore()}>{more ? t.common.loading : t.authoring.loadMore}</button>
            </div>
          )}
        </>
      )}
      {clearing && (
        <ConfirmDialog
          title={t.scores.clearTitle}
          description={t.scores.clearText}
          confirmLabel={t.scores.clearConfirm}
          danger
          busy={busy}
          onConfirm={() => void confirmClear()}
          onCancel={() => setClearing(false)}
        />
      )}
    </section>
  );
}
