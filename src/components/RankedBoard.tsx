import { useCallback, useEffect, useState } from 'react';
import type { MyRanked, RankedLeaderboard } from '../lib/api';
import { ApiError } from '../lib/client';
import { getMemberPreferences, getMyRanked, getRankedLeaderboard } from '../lib/playerApi';
import { formatTranslation } from '../translations';
import { useI18n } from './I18n';
import { RefreshIcon, TimerIcon } from './Icons';
import { useViewHeading } from './useViewHeading';

type BoardState =
  | { status: 'loading' }
  | { status: 'closed' }
  | { status: 'error'; cause: unknown }
  | { status: 'ready'; board: RankedLeaderboard };

/**
 * `?page=board` (#66): the one ranked board, public while Ranked mode is on.
 * Members who chose to appear on leaderboards, by display name only, best
 * rating first; members with few runs below, as provisional.
 */
export function RankedBoard({ signedIn, onPlay }: { signedIn: boolean; onPlay(): void }) {
  const { t, error, number, percent } = useI18n();
  const heading = useViewHeading('ranked:board');
  const [state, setState] = useState<BoardState>({ status: 'loading' });
  const [optedIn, setOptedIn] = useState<boolean | null>(null);
  useEffect(() => {
    if (!signedIn) { setOptedIn(null); return; }
    getMemberPreferences().then((preferences) => setOptedIn(preferences.leaderboardOptIn), () => setOptedIn(null));
  }, [signedIn]);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', board: await getRankedLeaderboard() });
    } catch (cause) {
      setState(cause instanceof ApiError && cause.code === 'ranked_closed' ? { status: 'closed' } : { status: 'error', cause });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const table = (caption: string, rows: readonly { rank?: number; displayName: string; rating: number; runs: number; accuracy: number }[], ranked: boolean) => (
    <div className="leaderboard-scroll" tabIndex={0} role="region" aria-label={caption}>
      <table className="leaderboard-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {ranked && <th scope="col">{t.ranked.boardRank}</th>}
            <th scope="col">{t.leaderboard.traveller}</th>
            <th scope="col">{t.ranked.ratingLabel}</th>
            <th scope="col">{t.ranked.boardRuns}</th>
            <th scope="col">{t.ranked.boardAccuracy}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.displayName}-${index}`}>
              {ranked && <td>{number(row.rank!)}</td>}
              <th scope="row">{row.displayName}</th>
              <td>{number(row.rating)}</td>
              <td>{number(row.runs)}</td>
              <td>{percent(row.accuracy)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <section className="player-section leaderboard" aria-labelledby="ranked-board-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{t.ranked.eyebrow}</p>
          <h1 id="ranked-board-heading" ref={heading} tabIndex={-1}>{t.ranked.boardTitle}</h1>
        </div>
        {signedIn && <button className="button button-primary button-with-icon" type="button" onClick={onPlay}><TimerIcon />{t.ranked.playRanked}</button>}
      </div>
      {state.status === 'loading' && <p className="loading-note" role="status">{t.ranked.boardLoading}</p>}
      {state.status === 'closed' && <p className="admin-notice" role="status">{t.errors.ranked_closed}</p>}
      {state.status === 'error' && (
        <div role="alert">
          <p className="error-note">{error(state.cause)}</p>
          <button className="button button-secondary button-with-icon" type="button" onClick={() => void load()}><RefreshIcon />{t.common.retry}</button>
        </div>
      )}
      {state.status === 'ready' && (
        <>
          <p className="workshop-intro">{formatTranslation(t.ranked.boardIntro, { runs: number(state.board.ratingRuns), count: number(state.board.provisionalRuns) })}</p>
          {state.board.entries.length === 0 && state.board.provisional.length === 0 && <p className="empty-note">{t.ranked.boardEmpty}</p>}
          {state.board.entries.length > 0 && table(t.ranked.boardCaption, state.board.entries, true)}
          {state.board.provisional.length > 0 && (
            <>
              <h2 className="scores-heading">{t.ranked.boardProvisional}</h2>
              {table(t.ranked.boardProvisional, state.board.provisional, false)}
            </>
          )}
          {signedIn && optedIn === false && <p className="field-help">{t.leaderboard.joinHint}</p>}
        </>
      )}
    </section>
  );
}

/** A member's own ranked standing on My scores (#66): only while Ranked mode is on, or once they have played. */
export function MyRankedSummary() {
  const { t, number, percent, date } = useI18n();
  const [mine, setMine] = useState<MyRanked | null>(null);
  useEffect(() => {
    getMyRanked().then(setMine, () => setMine(null));
  }, []);
  if (!mine || (!mine.enabled && mine.runs === 0)) return null;
  return (
    <section className="ranked-summary" aria-labelledby="ranked-summary-heading">
      <h2 id="ranked-summary-heading" className="scores-heading">{t.ranked.scoresTitle}</h2>
      <dl className="category-counts">
        <div><dt>{t.ranked.ratingLabel}</dt><dd>{mine.rating === null ? t.ranked.scoresUnranked : number(mine.rating)}</dd></div>
        <div><dt>{t.ranked.scoresRank}</dt><dd>{mine.rank === null ? t.ranked.scoresUnranked : number(mine.rank)}</dd></div>
        <div><dt>{t.ranked.boardRuns}</dt><dd>{number(mine.runs)}</dd></div>
        {mine.accuracy !== null && <div><dt>{t.ranked.boardAccuracy}</dt><dd>{percent(mine.accuracy)}</dd></div>}
      </dl>
      {mine.history.length > 0 && (
        <>
          <h3 className="ranked-summary-recent">{t.ranked.scoresRecent}</h3>
          <ul className="ranked-history">
            {mine.history.map((run) => (
              <li key={run.id}>
                <span>{formatTranslation(t.ranked.scoresRun, { score: number(run.score), correct: number(run.correctCount), total: number(run.countedCount) })}</span>
                {run.status === 'forfeited' && <span className="ranked-note"> · {t.ranked.scoresForfeited}</span>}
                <time dateTime={run.finishedAt}> · {date(run.finishedAt)}</time>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
