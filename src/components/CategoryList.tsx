import { useRef, useState } from 'react';
import type { CategoryStats, PublicCategory } from '../lib/api';
import { filterCategories } from '../lib/categoryFilter';
import { formatTranslation } from '../translations';
import { TextField } from './Field';
import { useI18n } from './I18n';
import { ArrowRightIcon, TrophyIcon } from './Icons';
import { useViewHeading } from './useViewHeading';

/** A member's best result and number of plays in a category (#69). */
export function PersonalBest({ stats }: { stats: CategoryStats }) {
  const { t, number, percent } = useI18n();
  return <span className="choice-card-meta personal-best">{formatTranslation(t.quiz.personalBest, { percent: percent(stats.bestPercent), plays: number(stats.plays) })}</span>;
}

/**
 * The categories (#16), lower priority first, then by name, as the API sorts
 * them. A category without approved questions is shown but cannot be chosen.
 * The filter (#74) narrows the list as the player types; it is not part of the
 * address (FE-4), and starts empty whenever the list is shown again. Each card
 * keeps its number in the full list.
 */
export function CategoryList({ categories, stats = null, notice, onChoose, onRankedBoard }: {
  categories: readonly PublicCategory[];
  /** A signed-in member's stats by category ID (#69); null for visitors, the Admin, or while unknown. */
  stats?: ReadonlyMap<string, CategoryStats> | null;
  /** Why the list is shown instead of a deep-linked category (FE-4). */
  notice: string | null;
  onChoose(category: PublicCategory): void;
  /** While Ranked mode is on (#66): opens the ranked board. */
  onRankedBoard?(): void;
}) {
  const { t, number } = useI18n();
  const heading = useViewHeading('categories');
  const total = categories.reduce((sum, category) => sum + category.questionCount, 0);
  const [query, setQuery] = useState('');
  const field = useRef<HTMLFormElement>(null);
  const shown = filterCategories(categories, query);
  const filtering = query.trim() !== '';
  function clear() {
    setQuery('');
    field.current?.querySelector('input')?.focus();
  }
  return (
    <section className="player-section" aria-labelledby="category-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{t.quiz.categoriesEyebrow}</p>
          <h1 id="category-heading" ref={heading} tabIndex={-1}>{t.quiz.chooseCategory}</h1>
        </div>
        <p className="section-heading-meta">{formatTranslation(t.quiz.totalQuestions, { count: number(total) })}</p>
        {onRankedBoard && (
          <button className="button button-secondary button-with-icon" type="button" onClick={onRankedBoard}><TrophyIcon />{t.ranked.boardLink}</button>
        )}
      </div>
      <div role="status">{notice && <p className="admin-notice">{notice}</p>}</div>
      {categories.length > 0 && (
        <form ref={field} className="category-filter" role="search" onSubmit={(event) => event.preventDefault()}>
          <TextField
            type="search"
            label={t.quiz.filterLabel}
            help={t.quiz.filterHelp}
            value={query}
            maxLength={100}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </form>
      )}
      <p className="category-filter-count" role="status">
        {filtering ? formatTranslation(t.quiz.filterCount, { shown: number(shown.length), total: number(categories.length) }) : ''}
      </p>
      {categories.length === 0 ? (
        <p className="player-empty">{t.quiz.noCategories}</p>
      ) : shown.length === 0 ? (
        <div className="category-filter-empty">
          <p className="player-empty">{formatTranslation(t.quiz.filterNoMatch, { query: query.trim() })}</p>
          <button className="button button-secondary" type="button" onClick={clear}>{t.quiz.filterClear}</button>
        </div>
      ) : (
        <ol className="choice-grid">
          {shown.map(({ category, number: position }) => (
            <li key={category.id}>
              <button className="choice-card" type="button" disabled={category.questionCount === 0} onClick={() => onChoose(category)}>
                <span className="choice-card-index" aria-hidden="true">{String(position).padStart(2, '0')}</span>
                <span className="choice-card-body">
                  <span className="choice-card-meta">
                    {formatTranslation(t.quiz.categoryMeta, { code: category.shortName, count: number(category.questionCount) })}
                  </span>
                  <span className="choice-card-name" lang="en">{category.name}</span>
                  <span className="choice-card-text" lang="en">{category.description}</span>
                  {category.questionCount === 0 && <span className="choice-card-meta">{t.quiz.noQuestionsYet}</span>}
                  {stats?.has(category.id) && <PersonalBest stats={stats.get(category.id)!} />}
                </span>
                <ArrowRightIcon className="choice-card-arrow" />
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
