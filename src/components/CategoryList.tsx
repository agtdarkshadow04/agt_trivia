import type { PublicCategory } from '../lib/api';
import { formatTranslation } from '../translations';
import { useI18n } from './I18n';
import { ArrowRightIcon } from './Icons';
import { useViewHeading } from './useViewHeading';

/**
 * The categories (#16), lower priority first, then by name, as the API sorts
 * them. A category without approved questions is shown but cannot be chosen.
 */
export function CategoryList({ categories, notice, onChoose }: {
  categories: readonly PublicCategory[];
  /** Why the list is shown instead of a deep-linked category (FE-4). */
  notice: string | null;
  onChoose(category: PublicCategory): void;
}) {
  const { t, number } = useI18n();
  const heading = useViewHeading('categories');
  const total = categories.reduce((sum, category) => sum + category.questionCount, 0);
  return (
    <section className="player-section" aria-labelledby="category-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{t.quiz.categoriesEyebrow}</p>
          <h1 id="category-heading" ref={heading} tabIndex={-1}>{t.quiz.chooseCategory}</h1>
        </div>
        <p className="section-heading-meta">{formatTranslation(t.quiz.totalQuestions, { count: number(total) })}</p>
      </div>
      <div role="status">{notice && <p className="admin-notice">{notice}</p>}</div>
      {categories.length === 0 ? (
        <p className="player-empty">{t.quiz.noCategories}</p>
      ) : (
        <ol className="choice-grid">
          {categories.map((category, index) => (
            <li key={category.id}>
              <button className="choice-card" type="button" disabled={category.questionCount === 0} onClick={() => onChoose(category)}>
                <span className="choice-card-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <span className="choice-card-body">
                  <span className="choice-card-meta">
                    {formatTranslation(t.quiz.categoryMeta, { code: category.shortName, count: number(category.questionCount) })}
                  </span>
                  <span className="choice-card-name" lang="en">{category.name}</span>
                  <span className="choice-card-text" lang="en">{category.description}</span>
                  {category.questionCount === 0 && <span className="choice-card-meta">{t.quiz.noQuestionsYet}</span>}
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
