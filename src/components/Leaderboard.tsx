import { useCallback, useEffect, useState } from 'react';
import type { PublicCategory, PublicLeaderboard } from '../lib/api';
import { ApiError } from '../lib/client';
import { getLeaderboard } from '../lib/playerApi';
import { formatTranslation } from '../translations';
import { useI18n } from './I18n';
import { RefreshIcon } from './Icons';
import { useViewHeading } from './useViewHeading';

type BoardState =
  | { status: 'loading' }
  | { status: 'closed' }
  | { status: 'error'; cause: unknown }
  | { status: 'ready'; board: PublicLeaderboard };

/**
 * `?category=<shortName>&view=leaderboard` (#49): the members who chose to
 * appear on the category's leaderboard, by display name only, best first.
 * While the Admin has leaderboards off it says so instead of hiding.
 */
export function Leaderboard({ category, signedIn, onPlay }: { category: PublicCategory; signedIn: boolean; onPlay(): void }) {
  const { t, error, number, percent } = useI18n();
  const heading = useViewHeading(`leaderboard:${category.id}`);
  const [state, setState] = useState<BoardState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', board: await getLeaderboard(category.id) });
    } catch (cause) {
      setState(cause instanceof ApiError && cause.code === 'leaderboards_closed' ? { status: 'closed' } : { status: 'error', cause });
    }
  }, [category.id]);
  useEffect(() => { void load(); }, [load]);

  return (
    <section className="player-section leaderboard" aria-labelledby="leaderboard-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow" lang="en">{category.name}</p>
          <h1 id="leaderboard-heading" ref={heading} tabIndex={-1}>{t.leaderboard.title}</h1>
        </div>
        <button className="button button-primary" type="button" onClick={onPlay}>{t.leaderboard.play}</button>
      </div>
      {state.status === 'loading' && <p className="loading-note" role="status">{t.leaderboard.loading}</p>}
      {state.status === 'closed' && <p className="admin-notice" role="status">{t.errors.leaderboards_closed}</p>}
      {state.status === 'error' && (
        <div role="alert">
          <p className="error-note">{error(state.cause)}</p>
          <button className="button button-secondary button-with-icon" type="button" onClick={() => void load()}><RefreshIcon />{t.common.retry}</button>
        </div>
      )}
      {state.status === 'ready' && (
        <>
          <p className="workshop-intro">{formatTranslation(t.leaderboard.intro, { count: number(state.board.minimumAnswers) })}</p>
          {state.board.entries.length === 0 ? <p className="empty-note">{t.leaderboard.empty}</p> : (
            <div className="leaderboard-scroll" tabIndex={0} role="region" aria-labelledby="leaderboard-heading">
              <table className="leaderboard-table">
                <caption className="sr-only">{formatTranslation(t.leaderboard.caption, { category: category.name })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t.leaderboard.rank}</th>
                    <th scope="col">{t.leaderboard.traveller}</th>
                    <th scope="col">{t.leaderboard.best}</th>
                    <th scope="col">{t.leaderboard.plays}</th>
                  </tr>
                </thead>
                <tbody>
                  {state.board.entries.map((entry) => (
                    <tr key={entry.rank}>
                      <td>{number(entry.rank)}</td>
                      <th scope="row">{entry.displayName}</th>
                      <td>{percent(entry.bestPercent)}</td>
                      <td>{number(entry.plays)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {signedIn && <p className="field-help">{t.leaderboard.joinHint}</p>}
        </>
      )}
    </section>
  );
}
