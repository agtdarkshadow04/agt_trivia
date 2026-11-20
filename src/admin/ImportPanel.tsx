import { type FormEvent, useState } from 'react';
import { EyeIcon, UploadIcon } from '../components/Icons';
import { ApiError } from '../lib/client';
import { fieldErrorText, type FieldError } from '../lib/errors';
import { formatTranslation } from '../translations';
import { importSheet, type ImportReport } from './api';
import { useAdminI18n } from './context';

type Files = { categories: File | null; questions: File | null };

/** The counts of a preview or an import. */
function Counts({ report }: { report: ImportReport }) {
  const { a, number } = useAdminI18n();
  const entries: [string, number][] = [
    [a.import.categoriesCreate, report.categories.create],
    [a.import.categoriesSkip, report.categories.skip],
    [a.import.questionsCreate, report.questions.create],
    [a.import.questionsSkip, report.questions.skip],
    [a.import.approved, report.questions.approved],
    [a.import.pending, report.questions.pending],
  ];
  return (
    <dl className="stats-grid">
      {entries.map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{number(count)}</dd></div>)}
    </dl>
  );
}

/** Every bad row, with its file, row and column, in the reader's language (I18N-6). */
function Problems({ problems }: { problems: readonly FieldError[] }) {
  const { a, t, number } = useAdminI18n();
  return (
    <>
      <h3>{formatTranslation(a.import.problemsTitle, { count: number(problems.length) })}</h3>
      <p className="field-help">{a.import.problemsText}</p>
      <ul className="import-problems">
        {problems.map((problem, index) => {
          const { row, column, value } = problem.params ?? {};
          const file = `${problem.field}.csv`;
          const where = column
            ? formatTranslation(a.import.problemAt, { file, row: number(Number(row)), column: String(column) })
            : formatTranslation(a.import.problemRow, { file, row: number(Number(row)) });
          return (
            <li key={index}>
              <strong>{where}</strong>{' '}
              {fieldErrorText(problem, String(column ?? file), t)}
              {value !== undefined && <> <q lang="en">{String(value)}</q></>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * UI-8 Import (#22): the 1.x Google Sheet's `validCategories` and
 * `pendingQuestions` tabs, downloaded as CSV, previewed, then imported in one
 * go. The server never fetches the sheet (SEC-14) and never keeps the files.
 */
export function ImportPanel() {
  const { a, error: describe, number } = useAdminI18n();
  const [files, setFiles] = useState<Files>({ categories: null, questions: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [problems, setProblems] = useState<FieldError[]>([]);
  const [preview, setPreview] = useState<ImportReport | null>(null);
  const [done, setDone] = useState<ImportReport | null>(null);
  const chosen = files.categories !== null || files.questions !== null;

  async function run(action: 'preview' | 'import') {
    setBusy(true);
    setError('');
    setProblems([]);
    try {
      const report = await importSheet(action, files);
      if (action === 'preview') setPreview(report);
      else { setDone(report); setPreview(null); }
    } catch (cause) {
      setError(describe(cause));
      // A file the server refused names it; an import refused for bad rows lists them.
      if (cause instanceof ApiError && cause.fields.some((field) => field.params?.row !== undefined)) setProblems(cause.fields);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  function choose(name: keyof Files, file: File | null) {
    setFiles((current) => ({ ...current, [name]: file }));
    setPreview(null);
    setDone(null);
    setError('');
    setProblems([]);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (chosen) void run('preview');
  }

  const nothingNew = preview !== null && preview.categories.create === 0 && preview.questions.create === 0;

  return (
    <div className="backup-sections">
      {error && <p className="error-note" role="alert">{error}</p>}
      <div role="status" aria-live="polite">
        {busy && <p className="field-help">{a.import.working}</p>}
        {done && <p className="success-note">{formatTranslation(a.import.done, { categories: number(done.categories.create), questions: number(done.questions.create) })}</p>}
      </div>
      {problems.length > 0 && <section className="admin-panel" aria-label={a.import.previewTitle}><Problems problems={problems} /></section>}
      <section className="admin-panel" aria-labelledby="import-title">
        <h2 id="import-title">{a.import.title}</h2>
        <p className="field-help">{a.import.intro}</p>
        <ol className="import-steps">
          {Object.values(a.import.steps).map((step) => <li key={step}>{formatTranslation(step, { tab: a.tabs.backup })}</li>)}
        </ol>
        <form className="stack-form" onSubmit={submit}>
          {(['categories', 'questions'] as const).map((name) => (
            <label key={name} className="field">
              <span>{name === 'categories' ? a.import.categoriesFile : a.import.questionsFile}</span>
              <input type="file" name={name} accept=".csv,text/csv,text/plain" onChange={(event) => choose(name, event.target.files?.[0] ?? null)} />
            </label>
          ))}
          <p className="field-help">{a.import.fileHelp}</p>
          <div className="form-actions">
            <button className="button button-secondary" disabled={busy || !chosen} type="submit"><EyeIcon /> {a.import.preview}</button>
          </div>
        </form>
      </section>
      {preview && (
        <section className="admin-panel" aria-labelledby="import-preview-title">
          <h2 id="import-preview-title">{a.import.previewTitle}</h2>
          <Counts report={preview} />
          <p className="field-help">{a.import.skipNote}</p>
          {preview.problems.length > 0 ? <Problems problems={preview.problems} /> : nothingNew ? <p>{a.import.nothingNew}</p> : (
            <>
              <p>{a.import.noProblems}</p>
              <div className="form-actions">
                <button className="button button-primary" disabled={busy} type="button" onClick={() => void run('import')}><UploadIcon /> {a.import.import}</button>
              </div>
            </>
          )}
        </section>
      )}
      {done && (
        <section className="admin-panel" aria-labelledby="import-done-title">
          <h2 id="import-done-title">{a.import.doneTitle}</h2>
          <Counts report={done} />
        </section>
      )}
    </div>
  );
}
