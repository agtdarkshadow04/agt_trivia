import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import type { CategoryBody, ManagedCategory, MemberQuestionStatus } from '../lib/api';
import { createCategory, deleteCategory, listManagedCategories, replaceCategory } from '../lib/playerApi';
import { categoryErrors, categoryLimits } from '../lib/validation';
import { formatTranslation } from '../translations';
import { ConfirmDialog, Dialog } from './Dialog';
import { formErrors, noFormErrors, TextAreaField, TextField } from './Field';
import { useI18n } from './I18n';
import { PencilIcon, PlusIcon, TrashIcon } from './Icons';
import { useViewHeading } from './useViewHeading';

/**
 * `?page=categories` (#20): Moderators list the categories in the order
 * players see them, with their questions counted by status, and create, edit
 * and delete them. A category with questions cannot be deleted
 * (`409 category_not_empty`); changing a short name breaks old links, which
 * the edit dialog says.
 */

type ListState =
  | { status: 'loading' }
  | { status: 'error'; cause: unknown }
  | { status: 'ready'; items: ManagedCategory[] };

const statuses: MemberQuestionStatus[] = ['approved', 'pending', 'draft', 'rejected'];

interface CategoryDraft {
  shortName: string;
  name: string;
  description: string;
  priority: string;
}

function draftBody(draft: CategoryDraft): CategoryBody {
  const priority = draft.priority.trim() === '' ? Number.NaN : Number(draft.priority);
  return { shortName: draft.shortName, name: draft.name, description: draft.description, priority };
}

/** The create and edit dialog. */
function CategoryDialog({ category, onSaved, onClose }: {
  /** null for a new category. */
  category: ManagedCategory | null;
  onSaved(category: ManagedCategory, message: string): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [draft, setDraft] = useState<CategoryDraft>(() => (category
    ? { shortName: category.shortName, name: category.name, description: category.description, priority: String(category.priority) }
    : { shortName: '', name: '', description: '', priority: '50' }));
  const [errors, setErrors] = useState(noFormErrors);
  const [busy, setBusy] = useState(false);
  const change = (update: Partial<CategoryDraft>) => setDraft((current) => ({ ...current, ...update }));
  const linkChanges = category !== null && draft.shortName.trim() !== category.shortName;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body = draftBody(draft);
    const problems = categoryErrors(body);
    setErrors(formErrors(problems, t));
    if (problems.length) return;
    setBusy(true);
    try {
      const result = category ? await replaceCategory(category.id, category.version, body) : await createCategory(body);
      onSaved(result.category, category ? t.categories.saved : t.categories.created);
    } catch (cause) {
      setErrors(formErrors(cause, t));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={category ? formatTranslation(t.categories.editTitle, { name: category.name }) : t.categories.newTitle}
      eyebrow={t.categories.eyebrow}
      onClose={() => { if (!busy) onClose(); }}
      footer={(
        <>
          <button className="button button-primary" type="submit" form={id} disabled={busy}>{busy ? t.authoring.saving : t.categories.save}</button>
          <button className="button button-secondary" type="button" disabled={busy} onClick={onClose}>{t.common.cancel}</button>
        </>
      )}
    >
      {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
      <form id={id} className="stack-form" noValidate onSubmit={(event) => void submit(event)}>
        <TextField label={t.fields.name} value={draft.name} lang="en" onChange={(event) => change({ name: event.target.value })} required error={errors.fields.name} />
        <TextField
          label={t.fields.shortName}
          value={draft.shortName}
          autoCapitalize="none"
          onChange={(event) => change({ shortName: event.target.value })}
          required
          help={t.categories.shortNameHelp}
          error={errors.fields.shortName}
        />
        {linkChanges && <p className="admin-notice" role="status">{formatTranslation(t.categories.shortNameWarning, { old: category.shortName })}</p>}
        <TextAreaField label={t.fields.description} value={draft.description} rows={3} lang="en" onChange={(event) => change({ description: event.target.value })} required error={errors.fields.description} />
        <TextField
          label={t.fields.priority}
          type="number"
          inputMode="numeric"
          min={categoryLimits.priority.min}
          max={categoryLimits.priority.max}
          step={1}
          value={draft.priority}
          onChange={(event) => change({ priority: event.target.value })}
          required
          help={t.categories.priorityHelp}
          error={errors.fields.priority}
        />
      </form>
    </Dialog>
  );
}

export function CategoryManager({ onChanged }: {
  /** After every change, so the game's category list follows. */
  onChanged(): void;
}) {
  const { t, error, number } = useI18n();
  const heading = useViewHeading('categories-manager');
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [editing, setEditing] = useState<ManagedCategory | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ManagedCategory | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [actionError, setActionError] = useState('');

  const load = useCallback(async () => {
    try {
      setList({ status: 'ready', items: await listManagedCategories() });
    } catch (cause) {
      setList({ status: 'error', cause });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  function done(text: string) {
    setMessage(text);
    setActionError('');
    onChanged();
    void load();
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await deleteCategory(deleting.id, deleting.version);
      setDeleting(null);
      done(t.categories.deleted);
    } catch (cause) {
      setDeleting(null);
      setMessage('');
      setActionError(error(cause));
      void load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="player-section" aria-labelledby="categories-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{t.categories.eyebrow}</p>
          <h1 id="categories-title" ref={heading} tabIndex={-1}>{t.categories.title}</h1>
        </div>
        <button
          className="button button-primary button-with-icon"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={editing === 'new'}
          onClick={() => { setMessage(''); setActionError(''); setEditing('new'); }}
        >
          <PlusIcon />{t.categories.newCategory}
        </button>
      </div>
      <p className="workshop-intro">{t.categories.text}</p>
      <div role="status" className="workshop-status">{message && <p className="success-note">{message}</p>}</div>
      {actionError && <p className="error-note" role="alert">{actionError}</p>}
      {list.status === 'loading' && <p className="loading-note" role="status">{t.common.loading}</p>}
      {list.status === 'error' && (
        <div role="alert">
          <p className="error-note">{error(list.cause)}</p>
          <button className="button button-secondary" type="button" onClick={() => void load()}>{t.common.retry}</button>
        </div>
      )}
      {list.status === 'ready' && (list.items.length === 0 ? (
        <p className="empty-note">{t.categories.empty}</p>
      ) : (
        <ol className="question-list">
          {list.items.map((category) => (
            <li key={category.id}>
              <article className="question-card" aria-labelledby={`category-${category.id}`}>
                <div className="question-card-meta">
                  <span>{formatTranslation(t.categories.meta, { code: category.shortName, priority: number(category.priority) })}</span>
                </div>
                <h2 id={`category-${category.id}`} className="question-card-prompt" lang="en">{category.name}</h2>
                <p className="category-description" lang="en">{category.description}</p>
                <dl className="category-counts" aria-label={t.categories.countsLabel}>
                  {statuses.map((status) => (
                    <div key={status}><dt>{t.authoring.statuses[status]}</dt><dd>{number(category.questionCounts[status])}</dd></div>
                  ))}
                </dl>
                <div className="form-actions" role="group" aria-label={formatTranslation(t.categories.actionsLabel, { name: category.name })}>
                  <button
                    className="button button-secondary button-with-icon"
                    type="button"
                    aria-haspopup="dialog"
                    aria-expanded={editing !== 'new' && editing?.id === category.id}
                    onClick={() => { setMessage(''); setActionError(''); setEditing(category); }}
                  >
                    <PencilIcon />{t.authoring.actions.edit}
                  </button>
                  <button
                    className="button button-danger button-with-icon"
                    type="button"
                    aria-haspopup="dialog"
                    aria-expanded={deleting?.id === category.id}
                    onClick={() => { setMessage(''); setActionError(''); setDeleting(category); }}
                  >
                    <TrashIcon />{t.authoring.actions.delete}
                  </button>
                </div>
              </article>
            </li>
          ))}
        </ol>
      ))}
      {editing !== null && (
        <CategoryDialog
          category={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(_category, text) => { setEditing(null); done(text); }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={formatTranslation(t.categories.deleteTitle, { name: deleting.name })}
          description={t.categories.deleteText}
          confirmLabel={t.categories.deleteConfirm}
          danger
          busy={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}
