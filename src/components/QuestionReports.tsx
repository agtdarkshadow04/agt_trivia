import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { QuestionReport } from '../lib/api';
import { closeReport, listReports, reportQuestion } from '../lib/playerApi';
import { REPORT_REASONS, reportInputErrors, reportLimits, resolutionNoteError, errorsOf } from '../lib/validation';
import { formatTranslation } from '../translations';
import { Dialog } from './Dialog';
import { formErrors, noFormErrors, SelectField, TextAreaField } from './Field';
import { useI18n } from './I18n';
import { CheckCircleIcon, FlagIcon, XCircleIcon } from './Icons';

/**
 * Question reports (#46). `ReportButton` lets a signed-in member report a
 * problem with a question they are playing or reviewing; `ReportsPanel` is the
 * Moderators' list on the review page, where they resolve or dismiss reports.
 */

function ReportDialog({ questionId, onSent, onCancel }: { questionId: string; onSent(): void; onCancel(): void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState(noFormErrors);
  const [busy, setBusy] = useState(false);
  const formId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    // FE-6: the server's own rules first.
    const problems = reportInputErrors({ reason, note });
    setErrors(formErrors(problems, t));
    if (problems.length) return;
    setBusy(true);
    try {
      await reportQuestion(questionId, reason, note);
      onSent();
    } catch (cause) {
      setErrors(formErrors(cause, t));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={t.reports.dialogTitle}
      description={t.reports.dialogText}
      onClose={() => { if (!busy) onCancel(); }}
      footer={(
        <>
          <button className="button button-primary" type="submit" form={formId} disabled={busy}>{t.reports.send}</button>
          <button className="button button-secondary" type="button" disabled={busy} onClick={onCancel}>{t.common.cancel}</button>
        </>
      )}
    >
      {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
      <form id={formId} className="stack-form" noValidate onSubmit={(event) => void submit(event)}>
        <SelectField label={t.fields.reason} value={reason} required onChange={(event) => setReason(event.target.value)} error={errors.fields.reason}>
          <option value="">{t.reports.chooseReason}</option>
          {REPORT_REASONS.map((value) => <option key={value} value={value}>{t.reports.reasons[value]}</option>)}
        </SelectField>
        <TextAreaField
          label={t.fields.note}
          value={note}
          rows={4}
          maxLength={reportLimits.note.max * 2}
          help={formatTranslation(t.reports.noteHelp, { max: reportLimits.note.max })}
          onChange={(event) => setNote(event.target.value)}
          error={errors.fields.note}
        />
      </form>
    </Dialog>
  );
}

/**
 * "Report a problem" for one question, with its dialog and a thank-you in a
 * live region once sent. Only for signed-in members: callers leave it out
 * for visitors, who would need ALTCHA (ALT-1).
 */
export function ReportButton({ questionId, prompt }: { questionId: string; prompt: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  // A new question starts afresh.
  useEffect(() => { setOpen(false); setSent(false); }, [questionId]);
  return (
    <span className="report-action">
      <button
        ref={button}
        className="button button-secondary button-with-icon"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={formatTranslation(t.reports.reportLabel, { prompt })}
        disabled={sent}
        onClick={() => setOpen(true)}
      >
        <FlagIcon />{t.reports.report}
      </button>
      <span role="status" className="report-sent">{sent ? t.reports.sent : ''}</span>
      {open && (
        <ReportDialog
          questionId={questionId}
          onCancel={() => setOpen(false)}
          onSent={() => { setOpen(false); setSent(true); }}
        />
      )}
    </span>
  );
}

function CloseReportDialog({ report, verb, onClosed, onCancel }: {
  report: QuestionReport;
  verb: 'resolve' | 'dismiss';
  onClosed(): void;
  onCancel(): void;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState(noFormErrors);
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const cancel = useRef<HTMLButtonElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problems = errorsOf(resolutionNoteError(note));
    setErrors(formErrors(problems, t));
    if (problems.length) return;
    setBusy(true);
    try {
      await closeReport(report.id, report.version, verb, note);
      onClosed();
    } catch (cause) {
      setErrors(formErrors(cause, t));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={verb === 'resolve' ? t.reports.resolveTitle : t.reports.dismissTitle}
      description={t.reports.closeText}
      initialFocusRef={cancel}
      onClose={() => { if (!busy) onCancel(); }}
      footer={(
        <>
          <button className={`button ${verb === 'resolve' ? 'button-primary' : 'button-danger'}`} type="submit" form={formId} disabled={busy}>
            {verb === 'resolve' ? t.reports.resolve : t.reports.dismiss}
          </button>
          <button ref={cancel} className="button button-secondary" type="button" disabled={busy} onClick={onCancel}>{t.common.cancel}</button>
        </>
      )}
    >
      {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
      <form id={formId} className="stack-form" noValidate onSubmit={(event) => void submit(event)}>
        <TextAreaField label={t.fields.resolutionNote} value={note} rows={3} onChange={(event) => setNote(event.target.value)} error={errors.fields.resolutionNote} />
      </form>
    </Dialog>
  );
}

type ReportList =
  | { status: 'loading' }
  | { status: 'error'; cause: unknown }
  | { status: 'ready'; items: QuestionReport[]; nextCursor: string | null };

/** The Moderators' open reports on the review page (#46), oldest first. */
export function ReportsPanel({ onChanged }: { onChanged(): void }) {
  const { t, error, date } = useI18n();
  const [list, setList] = useState<ReportList>({ status: 'loading' });
  const [closing, setClosing] = useState<{ report: QuestionReport; verb: 'resolve' | 'dismiss' } | null>(null);
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const headingId = useId();

  const load = useCallback(async () => {
    setList({ status: 'loading' });
    try {
      const page = await listReports();
      setList({ status: 'ready', items: page.items, nextCursor: page.nextCursor });
    } catch (cause) {
      setList({ status: 'error', cause });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function more() {
    if (list.status !== 'ready' || !list.nextCursor) return;
    try {
      const page = await listReports(list.nextCursor);
      setList({ status: 'ready', items: [...list.items, ...page.items], nextCursor: page.nextCursor });
    } catch (cause) {
      setLoadError(error(cause));
    }
  }

  return (
    <section className="reports-panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{t.reports.title}</h2>
      <p className="workshop-intro">{t.reports.intro}</p>
      <div role="status" className="workshop-status">{message && <p className="success-note">{message}</p>}</div>
      {loadError && <p className="error-note" role="alert">{loadError}</p>}
      {list.status === 'loading' && <p className="loading-note" role="status">{t.reports.loading}</p>}
      {list.status === 'error' && (
        <div role="alert">
          <p className="error-note">{error(list.cause)}</p>
          <button className="button button-secondary" type="button" onClick={() => void load()}>{t.common.retry}</button>
        </div>
      )}
      {list.status === 'ready' && (list.items.length === 0 ? <p className="empty-note">{t.reports.empty}</p> : (
        <ul className="question-list">
          {list.items.map((report) => (
            <li key={report.id}>
              <article className="question-card report-card" aria-labelledby={`${report.id}-prompt`}>
                <div className="question-card-meta">
                  <span className="question-status">{t.reports.reasons[report.reason]}</span>
                  <span lang="en">{report.categoryName}</span>
                  <span>
                    {report.reportedByName
                      ? formatTranslation(t.reports.reportedBy, { name: report.reportedByName, date: date(report.createdAt) })
                      : formatTranslation(t.reports.reportedByFormer, { date: date(report.createdAt) })}
                  </span>
                </div>
                <h3 id={`${report.id}-prompt`} className="question-card-prompt" lang="en">{report.questionPrompt}</h3>
                {report.questionStatus !== 'approved' && <p className="admin-notice">{t.reports.notInQuiz}</p>}
                {report.note && (
                  <div className="question-note">
                    <strong>{t.fields.note}</strong>
                    <p>{report.note}</p>
                  </div>
                )}
                <div className="form-actions" role="group" aria-label={formatTranslation(t.reports.actionsLabel, { prompt: report.questionPrompt })}>
                  {(['resolve', 'dismiss'] as const).map((verb) => (
                    <button
                      key={verb}
                      className={`button ${verb === 'resolve' ? 'button-primary' : 'button-secondary'} button-with-icon`}
                      type="button"
                      aria-haspopup="dialog"
                      aria-expanded={closing?.report.id === report.id && closing.verb === verb}
                      onClick={() => { setMessage(''); setClosing({ report, verb }); }}
                    >
                      {verb === 'resolve' ? <CheckCircleIcon /> : <XCircleIcon />}{verb === 'resolve' ? t.reports.resolve : t.reports.dismiss}
                    </button>
                  ))}
                </div>
              </article>
            </li>
          ))}
        </ul>
      ))}
      {list.status === 'ready' && list.nextCursor && (
        <div className="form-actions">
          <button className="button button-secondary" type="button" onClick={() => void more()}>{t.reports.loadMore}</button>
        </div>
      )}
      {closing && (
        <CloseReportDialog
          report={closing.report}
          verb={closing.verb}
          onCancel={() => setClosing(null)}
          onClosed={() => {
            setMessage(closing.verb === 'resolve' ? t.reports.resolved : t.reports.dismissed);
            setClosing(null);
            onChanged();
            void load();
          }}
        />
      )}
    </section>
  );
}
