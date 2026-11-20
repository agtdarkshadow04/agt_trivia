import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import type { MemberQuestion, MemberQuestionStatus, MemberSession, PublicCategory } from '../lib/api';
import { roleAtLeast } from '../lib/api';
import { fieldErrorText, type FieldError } from '../lib/errors';
import { changeQuestionStatus, createQuestion, deleteQuestion, listQuestions, rejectQuestion, replaceQuestion } from '../lib/playerApi';
import { canAddChoice, canRemoveChoice, choiceLetter, draftBody, draftErrors, draftFromQuestion, emptyDraft, type QuestionDraft } from '../lib/questionForm';
import { allowedQuestionActions, canChangeCredit, defaultCredit, type QuestionAction } from '../lib/questionRules';
import { errorsOf, questionLimits, questionNotices, reviewNoteError } from '../lib/validation';
import { formatTranslation } from '../translations';
import { ConfirmDialog, Dialog } from './Dialog';
import { formErrors, noFormErrors, SelectField, TextAreaField, TextField } from './Field';
import { useI18n } from './I18n';
import { ArrowLeftIcon, CheckCircleIcon, PencilIcon, PlusIcon, RotateCcwIcon, SendIcon, TrashIcon, XCircleIcon } from './Icons';
import { useViewHeading } from './useViewHeading';

/**
 * The question workshop (#19): `?page=questions` lists the member's questions
 * (Moderators can show everyone's) with the question form, and `?page=review`
 * is the Moderators' review queue. What a member may do comes from
 * `src/lib/questionRules.ts`, the rules the server enforces.
 */

type Mode = 'questions' | 'review';

type ListState =
  | { status: 'loading' }
  | { status: 'error'; cause: unknown }
  | { status: 'ready'; items: MemberQuestion[]; nextCursor: string | null; more: 'idle' | 'loading' };

/** The status as words, never colour alone (A11Y-1). */
function StatusBadge({ status }: { status: MemberQuestionStatus }) {
  const { t } = useI18n();
  return <span className={`question-status question-status-${status}`}>{t.authoring.statuses[status]}</span>;
}

/** The writing guidelines of the 1.x sheet, as help text. */
function Guidelines() {
  const { t } = useI18n();
  return (
    <aside className="question-guidelines" aria-labelledby="question-guidelines-title">
      <h2 id="question-guidelines-title">{t.authoring.guidelinesTitle}</h2>
      <ul>
        {Object.values(t.authoring.guidelines).map((line) => <li key={line}>{line}</li>)}
      </ul>
    </aside>
  );
}

/** The question as players see it once they have answered: the correct answers marked in words and with an icon. */
function QuestionPreview({ draft, credit, categoryName }: { draft: QuestionDraft; credit: string; categoryName: string }) {
  const { t } = useI18n();
  const correct = draft.choices.filter((choice) => choice.isCorrect).length;
  const prompt = draft.prompt.trim();
  return (
    <section className="question-preview" aria-labelledby="question-preview-title">
      <h2 id="question-preview-title">{t.authoring.previewTitle}</h2>
      <p className="preview-intro">{t.authoring.previewText}</p>
      <div className="quiz-panel">
        {categoryName && <div className="quiz-meta"><span lang="en">{categoryName}</span></div>}
        <p className="selection-hint">{correct > 1 ? t.quiz.selectAll : t.quiz.selectOne}</p>
        <p className="question-prompt preview-prompt" lang="en">{prompt || t.authoring.previewEmpty}</p>
        <ol className="answer-list">
          {draft.choices.map((choice, index) => (
            <li key={index}>
              <span className={`answer ${choice.isCorrect ? 'answer-correct' : 'answer-muted'}`}>
                <span className="answer-marker" aria-hidden="true">{choiceLetter(index)}</span>
                <span className="answer-text" lang="en">{choice.text.trim() || '—'}</span>
                {choice.isCorrect && <span className="answer-state answer-state-correct"><CheckCircleIcon />{t.authoring.correctAnswer}</span>}
              </span>
            </li>
          ))}
        </ol>
        <div className="quiz-actions">
          <span className="quiz-credit">{credit.trim() ? formatTranslation(t.quiz.submittedBy, { author: credit.trim() }) : t.quiz.allianceArchive}</span>
        </div>
      </div>
    </section>
  );
}

/** A new question, or one being changed, with the guidelines and the live preview. */
function QuestionForm({ member, categories, question, onDone, onBack }: {
  member: MemberSession;
  categories: PublicCategory[];
  /** null for a new question. */
  question: MemberQuestion | null;
  onDone(question: MemberQuestion, message: string, notices: FieldError[]): void;
  onBack(): void;
}) {
  const { t } = useI18n();
  const heading = useViewHeading(question ? `edit:${question.id}` : 'new-question');
  const withCredit = canChangeCredit(member.role);
  const ownCredit = defaultCredit(member.displayName, questionLimits.authorCredit.max) ?? '';
  const [draft, setDraft] = useState<QuestionDraft>(() => (question ? draftFromQuestion(question) : emptyDraft('', ownCredit)));
  const [errors, setErrors] = useState(noFormErrors);
  const [busy, setBusy] = useState(false);
  const maySubmit = question === null || allowedQuestionActions(member, question).includes('submit');
  const labels: Record<string, string> = {
    ...Object.fromEntries(draft.choices.map((_, index) => [`choices.${index}`, formatTranslation(t.authoring.answerLabel, { letter: choiceLetter(index) })])),
  };
  const notices = questionNotices(draft);
  const categoryName = categories.find((category) => category.id === draft.categoryId)?.name ?? '';

  const change = (update: Partial<QuestionDraft>) => setDraft((current) => ({ ...current, ...update }));
  const changeChoice = (index: number, update: Partial<QuestionDraft['choices'][number]>) => setDraft((current) => ({
    ...current,
    choices: current.choices.map((choice, position) => (position === index ? { ...choice, ...update } : choice)),
  }));

  async function save(submit: boolean) {
    const problems = draftErrors(draft, withCredit);
    setErrors(formErrors(problems, t, labels));
    if (problems.length) return;
    setBusy(true);
    try {
      const body = draftBody(draft, withCredit);
      let result = question ? await replaceQuestion(question.id, question.version, body) : await createQuestion(body);
      let message = question ? t.authoring.saved : t.authoring.created;
      if (submit) {
        result = { ...result, question: await changeQuestionStatus(result.question.id, result.question.version, 'submit') };
        message = t.authoring.submitted;
      }
      onDone(result.question, message, result.notices);
    } catch (cause) {
      setErrors(formErrors(cause, t, labels));
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void save(false);
  }

  return (
    <section className="player-section" aria-labelledby="question-form-title">
      <div className="quiz-bar">
        <button className="button button-secondary button-with-icon" type="button" onClick={onBack}><ArrowLeftIcon />{t.authoring.back}</button>
      </div>
      <div className="section-heading">
        <div>
          <p className="eyebrow">{t.authoring.eyebrow}</p>
          <h1 id="question-form-title" ref={heading} tabIndex={-1}>{question ? t.authoring.editTitle : t.authoring.newTitle}</h1>
        </div>
        {question && <StatusBadge status={question.status} />}
      </div>
      {question?.reviewNote && (
        <div className="question-note">
          <strong>{t.authoring.reviewNote}</strong>
          <p lang="en">{question.reviewNote}</p>
        </div>
      )}
      {question?.status === 'approved' && <p className="admin-notice">{t.authoring.approvedNotice}</p>}
      <div className="question-workspace">
        <div className="question-form-column">
          {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
          <form className="stack-form question-form" noValidate onSubmit={onSubmit}>
            <SelectField label={t.fields.categoryId} value={draft.categoryId} onChange={(event) => change({ categoryId: event.target.value })} required error={errors.fields.categoryId}>
              <option value="">{t.authoring.chooseCategory}</option>
              {categories.map((category) => <option key={category.id} value={category.id} lang="en">{category.name}</option>)}
            </SelectField>
            <TextAreaField
              label={t.fields.prompt}
              value={draft.prompt}
              rows={3}
              lang="en"
              onChange={(event) => change({ prompt: event.target.value })}
              required
              help={notices.length ? formatTranslation(t.fieldErrors.too_many_words, { field: t.fields.prompt, max: questionLimits.promptWords, count: notices[0].params?.count ?? 0 }) : t.authoring.promptHelp}
              error={errors.fields.prompt}
            />
            <fieldset className="question-choices">
              <legend>{t.fields.choices}</legend>
              <p className="field-help" id="question-choices-help">{t.authoring.answersHelp}</p>
              {errors.fields.choices && <p className="field-error">{errors.fields.choices}</p>}
              <ol className="question-choice-list">
                {draft.choices.map((choice, index) => {
                  const letter = choiceLetter(index);
                  return (
                    <li key={index} className="question-choice">
                      <TextField
                        label={formatTranslation(t.authoring.answerLabel, { letter })}
                        value={choice.text}
                        lang="en"
                        onChange={(event) => changeChoice(index, { text: event.target.value })}
                        required
                        error={errors.fields[`choices.${index}`]}
                      />
                      <div className="question-choice-actions">
                        <label className="check-field">
                          <input type="checkbox" checked={choice.isCorrect} onChange={(event) => changeChoice(index, { isCorrect: event.target.checked })} aria-label={formatTranslation(t.authoring.correctLabel, { letter })} />
                          {t.authoring.correct}
                        </label>
                        {canRemoveChoice(draft) && (
                          <button
                            className="button button-secondary button-icon"
                            type="button"
                            aria-label={formatTranslation(t.authoring.removeAnswer, { letter })}
                            title={formatTranslation(t.authoring.removeAnswer, { letter })}
                            onClick={() => change({ choices: draft.choices.filter((_, position) => position !== index) })}
                          >
                            <TrashIcon />
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
              {canAddChoice(draft) && (
                <div className="form-actions">
                  <button className="button button-secondary button-with-icon" type="button" onClick={() => change({ choices: [...draft.choices, { text: '', isCorrect: false }] })}>
                    <PlusIcon />{t.authoring.addAnswer}
                  </button>
                </div>
              )}
            </fieldset>
            {withCredit ? (
              <TextField label={t.fields.authorCredit} value={draft.authorCredit} onChange={(event) => change({ authorCredit: event.target.value })} help={t.authoring.creditHelp} error={errors.fields.authorCredit} />
            ) : (
              <p className="field-help">{formatTranslation(t.authoring.creditFixed, { name: (question ? question.authorCredit : ownCredit) || '—' })}</p>
            )}
            <div className="form-actions">
              <button className="button button-primary" type="submit" disabled={busy}>{busy ? t.authoring.saving : question ? t.authoring.saveChanges : t.authoring.save}</button>
              {maySubmit && (
                <button className="button button-secondary button-with-icon" type="button" disabled={busy} onClick={() => void save(true)}><SendIcon />{t.authoring.saveSubmit}</button>
              )}
            </div>
          </form>
        </div>
        <div className="question-side-column">
          <QuestionPreview draft={draft} credit={withCredit ? draft.authorCredit : (question ? question.authorCredit ?? '' : ownCredit)} categoryName={categoryName} />
          <Guidelines />
        </div>
      </div>
    </section>
  );
}

/** A Moderator's reason for rejecting a question; the author sees it. */
function RejectDialog({ question, onRejected, onCancel }: { question: MemberQuestion; onRejected(question: MemberQuestion): void; onCancel(): void }) {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState(noFormErrors);
  const [busy, setBusy] = useState(false);
  const id = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problems = errorsOf(reviewNoteError(note));
    setErrors(formErrors(problems, t));
    if (problems.length) return;
    setBusy(true);
    try {
      onRejected(await rejectQuestion(question.id, question.version, note));
    } catch (cause) {
      setErrors(formErrors(cause, t));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={t.authoring.rejectTitle}
      description={t.authoring.rejectText}
      onClose={() => { if (!busy) onCancel(); }}
      footer={(
        <>
          <button className="button button-danger" type="submit" form={id} disabled={busy}>{t.authoring.rejectConfirm}</button>
          <button className="button button-secondary" type="button" disabled={busy} onClick={onCancel}>{t.common.cancel}</button>
        </>
      )}
    >
      {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
      <form id={id} className="stack-form" noValidate onSubmit={(event) => void submit(event)}>
        <TextAreaField label={t.fields.reviewNote} value={note} rows={4} lang="en" onChange={(event) => setNote(event.target.value)} required error={errors.fields.reviewNote} />
      </form>
    </Dialog>
  );
}

const actionIcons: Partial<Record<QuestionAction, typeof PencilIcon>> = {
  edit: PencilIcon, submit: SendIcon, approve: CheckCircleIcon, reject: XCircleIcon, unpublish: RotateCcwIcon, delete: TrashIcon,
};

/** One question in a list: its text, answers, status, note and the member's actions. */
function QuestionCard({ question, member, categoryName, showAuthor, openAction, onAction }: {
  question: MemberQuestion;
  /** The action whose dialog is open for this question, if any. */
  openAction: QuestionAction | null;
  member: MemberSession;
  categoryName: string;
  showAuthor: boolean;
  onAction(action: QuestionAction): void;
}) {
  const { t } = useI18n();
  const id = useId();
  const actions = allowedQuestionActions(member, question);
  return (
    <article className="question-card" aria-labelledby={`${id}-prompt`}>
      <div className="question-card-meta">
        <StatusBadge status={question.status} />
        <span lang="en">{categoryName}</span>
        {showAuthor && <span>{question.createdByName ? formatTranslation(t.authoring.writtenBy, { name: question.createdByName }) : t.authoring.noAuthor}</span>}
      </div>
      <h2 id={`${id}-prompt`} className="question-card-prompt" lang="en">{question.prompt}</h2>
      <ol className="question-card-answers">
        {question.choices.map((choice, index) => (
          <li key={choice.id}>
            <span aria-hidden="true">{choiceLetter(index)}</span>
            <span lang="en">{choice.text}</span>
            {choice.isCorrect && <span className="answer-state answer-state-correct"><CheckCircleIcon />{t.authoring.correctAnswer}</span>}
          </li>
        ))}
      </ol>
      {question.reviewNote && (
        <div className="question-note">
          <strong>{t.authoring.reviewNote}</strong>
          <p lang="en">{question.reviewNote}</p>
        </div>
      )}
      {actions.length > 0 && (
        <div className="form-actions" role="group" aria-label={formatTranslation(t.authoring.actionsLabel, { prompt: question.prompt })}>
          {actions.map((action) => {
            const Icon = actionIcons[action]!;
            const primary = action === 'approve' || action === 'submit';
            const danger = action === 'delete' || action === 'reject';
            return (
              <button
                key={action}
                className={`button ${primary ? 'button-primary' : danger ? 'button-danger' : 'button-secondary'} button-with-icon`}
                type="button"
                onClick={() => onAction(action)}
                {...(danger ? { 'aria-haspopup': 'dialog' as const, 'aria-expanded': openAction === action } : {})}
              >
                <Icon />{t.authoring.actions[action]}
              </button>
            );
          })}
        </div>
      )}
    </article>
  );
}

const statusFilters: (MemberQuestionStatus | '')[] = ['', 'draft', 'pending', 'approved', 'rejected'];

export function QuestionWorkshop({ mode, member, categories, onChanged }: {
  mode: Mode;
  member: MemberSession;
  categories: PublicCategory[];
  /** After every change, so the header's review count can follow. */
  onChanged(): void;
}) {
  const { t, error } = useI18n();
  const moderator = roleAtLeast(member.role, 'Moderator');
  const heading = useViewHeading(`workshop:${mode}`);
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [statusFilter, setStatusFilter] = useState<MemberQuestionStatus | ''>('');
  const [everyone, setEveryone] = useState(false);
  const [editing, setEditing] = useState<MemberQuestion | 'new' | null>(null);
  const [rejecting, setRejecting] = useState<MemberQuestion | null>(null);
  const [deleting, setDeleting] = useState<MemberQuestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [notices, setNotices] = useState<string[]>([]);
  const [actionError, setActionError] = useState('');

  const query = mode === 'review' ? { status: 'pending' as const } : { status: statusFilter || undefined, mine: !(moderator && everyone) };
  const queryKey = JSON.stringify(query);

  const load = useCallback(async () => {
    setList({ status: 'loading' });
    try {
      const page = await listQuestions(JSON.parse(queryKey) as typeof query);
      setList({ status: 'ready', items: page.items, nextCursor: page.nextCursor, more: 'idle' });
    } catch (cause) {
      setList({ status: 'error', cause });
    }
  }, [queryKey]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setEditing(null); setMessage(''); setNotices([]); setActionError(''); }, [mode]);

  async function loadMore() {
    if (list.status !== 'ready' || !list.nextCursor) return;
    setList({ ...list, more: 'loading' });
    try {
      const page = await listQuestions({ ...query, cursor: list.nextCursor });
      setList({ status: 'ready', items: [...list.items, ...page.items], nextCursor: page.nextCursor, more: 'idle' });
    } catch (cause) {
      setList({ ...list, more: 'idle' });
      setActionError(error(cause));
    }
  }

  /** A notice of a saved question (API-2) in the reader's words. */
  const noticeText = (notice: FieldError) => (notice.code === 'duplicate'
    ? t.authoring.duplicateNotice
    : fieldErrorText(notice, t.fields[notice.field as keyof typeof t.fields] ?? notice.field, t));

  const categoryName = (id: string) => categories.find((category) => category.id === id)?.name ?? '';

  function done(text: string, noticeTexts: string[] = []) {
    setMessage(text);
    setNotices(noticeTexts);
    setActionError('');
    onChanged();
    void load();
  }

  async function act(question: MemberQuestion, action: QuestionAction) {
    setMessage('');
    setActionError('');
    if (action === 'edit') { setEditing(question); return; }
    if (action === 'reject') { setRejecting(question); return; }
    if (action === 'delete') { setDeleting(question); return; }
    setBusy(true);
    try {
      await changeQuestionStatus(question.id, question.version, action);
      done({ submit: t.authoring.submitted, approve: t.authoring.approved, unpublish: t.authoring.unpublished }[action]);
    } catch (cause) {
      setActionError(error(cause));
      void load();
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await deleteQuestion(deleting.id, deleting.version);
      setDeleting(null);
      done(t.authoring.deleted);
    } catch (cause) {
      setDeleting(null);
      setActionError(error(cause));
      void load();
    } finally {
      setBusy(false);
    }
  }

  const statusLine = (
    <div role="status" className="workshop-status">
      {message && <p className="success-note">{message}</p>}
      {notices.length > 0 && (
        <div className="admin-notice">
          <strong>{t.authoring.noticesTitle}</strong>
          <ul>{notices.map((notice) => <li key={notice}>{notice}</li>)}</ul>
        </div>
      )}
    </div>
  );

  if (editing !== null) {
    return (
      <QuestionForm
        member={member}
        categories={categories}
        question={editing === 'new' ? null : editing}
        onBack={() => setEditing(null)}
        onDone={(_question, text, received) => { setEditing(null); done(text, received.map(noticeText)); }}
      />
    );
  }

  const review = mode === 'review';
  return (
    <section className="player-section" aria-labelledby="workshop-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{t.authoring.eyebrow}</p>
          <h1 id="workshop-title" ref={heading} tabIndex={-1}>{review ? t.authoring.reviewTitle : t.authoring.questionsTitle}</h1>
        </div>
        {!review && (
          <button className="button button-primary button-with-icon" type="button" onClick={() => { setMessage(''); setNotices([]); setEditing('new'); }}>
            <PlusIcon />{t.authoring.newQuestion}
          </button>
        )}
      </div>
      <p className="workshop-intro">{review ? t.authoring.reviewText : t.authoring.questionsText}</p>
      {statusLine}
      {actionError && <p className="error-note" role="alert">{actionError}</p>}
      {!review && (
        <div className="workshop-filters">
          <SelectField label={t.authoring.status} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as MemberQuestionStatus | '')}>
            {statusFilters.map((value) => <option key={value} value={value}>{value ? t.authoring.statuses[value] : t.authoring.allStatuses}</option>)}
          </SelectField>
          {moderator && (
            <SelectField label={t.authoring.show} value={everyone ? 'all' : 'mine'} onChange={(event) => setEveryone(event.target.value === 'all')}>
              <option value="mine">{t.authoring.showMine}</option>
              <option value="all">{t.authoring.showAll}</option>
            </SelectField>
          )}
        </div>
      )}
      {list.status === 'loading' && <p className="loading-note" role="status">{t.authoring.loading}</p>}
      {list.status === 'error' && (
        <div role="alert">
          <p className="error-note">{error(list.cause)}</p>
          <button className="button button-secondary" type="button" onClick={() => void load()}>{t.common.retry}</button>
        </div>
      )}
      {list.status === 'ready' && (list.items.length === 0 ? (
        <p className="empty-note">{review ? t.authoring.reviewEmpty : statusFilter ? t.authoring.emptyFiltered : t.authoring.empty}</p>
      ) : (
        <ul className="question-list" aria-busy={busy}>
          {list.items.map((question) => (
            <li key={question.id}>
              <QuestionCard
                question={question}
                member={member}
                categoryName={categoryName(question.categoryId)}
                showAuthor={review || everyone}
                openAction={rejecting?.id === question.id ? 'reject' : deleting?.id === question.id ? 'delete' : null}
                onAction={(action) => { if (!busy) void act(question, action); }}
              />
            </li>
          ))}
        </ul>
      ))}
      {list.status === 'ready' && list.nextCursor && (
        <div className="form-actions">
          <button className="button button-secondary" type="button" disabled={list.more === 'loading'} onClick={() => void loadMore()}>{list.more === 'loading' ? t.common.loading : t.authoring.loadMore}</button>
        </div>
      )}
      {rejecting && (
        <RejectDialog
          question={rejecting}
          onCancel={() => setRejecting(null)}
          onRejected={() => { setRejecting(null); done(t.authoring.rejected); }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t.authoring.deleteTitle}
          description={t.authoring.deleteText}
          confirmLabel={t.authoring.deleteConfirm}
          danger
          busy={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}
