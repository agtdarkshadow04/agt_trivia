import { type FormEvent, useState } from 'react';
import { DownloadIcon, EyeIcon, UploadIcon } from '../components/Icons';
import { ApiError } from '../lib/client';
import { formatTranslation } from '../translations';
import { downloadBackup, previewBackup, restoreBackup, type RestoreReport } from './api';
import { useAdminI18n } from './context';
import { saveFile } from './download';
import type { AdminTranslations } from './i18n';

type Reason = keyof AdminTranslations['backup']['reasons'];

function Counts({ counts }: { counts: RestoreReport['counts'] }) {
  const { a, number } = useAdminI18n();
  return (
    <dl className="stats-grid">
      {(Object.keys(counts) as (keyof RestoreReport['counts'])[]).map((table) => (
        <div key={table}><dt>{a.backup.tables[table]}</dt><dd>{number(counts[table])}</dd></div>
      ))}
    </dl>
  );
}

/** A refused archive's translated reason (`params.reason`, I18N-6), with the server's English details kept for support. */
function rejection(cause: unknown, a: AdminTranslations) {
  if (!(cause instanceof ApiError) || cause.code !== 'archive_rejected') return null;
  const reason = cause.params.reason;
  const text = typeof reason === 'string' && reason in a.backup.reasons ? a.backup.reasons[reason as Reason] : undefined;
  return text ? { text, details: cause.message } : null;
}

/** BAK-3: what the backup holds, and how its config.yaml differs (BAK-5). */
function PreviewDetails({ preview }: { preview: RestoreReport }) {
  const { a, dateTime } = useAdminI18n();
  const { config } = preview;
  return (
    <>
      <p>{formatTranslation(a.backup.created, { date: dateTime(preview.createdAt), version: preview.appVersion, schema: preview.schemaVersion.backup })}</p>
      {preview.schemaVersion.backup < preview.schemaVersion.current && (
        <p className="admin-notice">{formatTranslation(a.backup.olderVersion, { from: preview.schemaVersion.backup, to: preview.schemaVersion.current })}</p>
      )}
      {preview.warningCodes.map((code) => <p className="admin-notice" key={code}>{a.backup.warnings[code]}</p>)}
      <Counts counts={preview.counts} />
      {preview.ignoredSettings.length > 0 && (
        <p className="admin-notice">{formatTranslation(a.backup.ignoredSettings, { keys: preview.ignoredSettings.join(', ') })}</p>
      )}
      <h3>{a.backup.configTitle}</h3>
      {!config.included && <p className="field-help">{a.backup.noConfig}</p>}
      {config.included && (
        <>
          <p className="field-help">{a.backup.configNeverRestored} {config.identical ? a.backup.configIdentical : a.backup.configDifferent}</p>
          {!config.identical && (
            <pre className="config-diff" aria-label={a.backup.configDiff} tabIndex={0}>
              {config.diff.map((line, index) => (
                <span key={index} className={`diff-${line.kind === '+' ? 'added' : line.kind === '-' ? 'removed' : 'same'}`}>{line.kind} {line.text}{'\n'}</span>
              ))}
            </pre>
          )}
          {config.content !== null && (
            <div className="form-actions">
              <button className="button button-secondary button-with-icon" type="button" onClick={() => saveFile(new Blob([config.content!], { type: 'text/yaml' }), 'config.from-backup.yaml')}>
                <DownloadIcon />{a.backup.downloadConfig}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

/**
 * UI-8 Backup & restore (BAK-1): download a backup; upload one to preview it,
 * then restore it after confirming. A restore signs everyone out, so the
 * dashboard then asks for the restored Admin's sign-in.
 */
export function BackupPanel({ onRestored }: { onRestored(): void }) {
  const { a, error: describe } = useAdminI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [details, setDetails] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<RestoreReport | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [report, setReport] = useState<RestoreReport | null>(null);

  async function run<Result>(work: () => Result) {
    setBusy(true);
    setError('');
    setDetails('');
    try {
      await work();
    } catch (cause) {
      const rejected = rejection(cause, a);
      setError(rejected ? `${describe(cause)} ${rejected.text}` : describe(cause));
      setDetails(rejected?.details ?? '');
    } finally {
      setBusy(false);
    }
  }

  const download = () => run(async () => {
    const { blob, filename } = await downloadBackup();
    saveFile(blob, filename);
  });

  function runPreview(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setPreview(null);
    setConfirmed(false);
    void run(async () => setPreview(await previewBackup(file)));
  }

  const restore = () => run(async () => {
    if (!file || !preview || !confirmed) return;
    setReport(await restoreBackup(file));
  });

  if (report) {
    return (
      <section className="admin-panel" aria-labelledby="backup-restored-title">
        <h2 id="backup-restored-title">{a.backup.restoredTitle}</h2>
        <p role="status">{a.backup.restoredText}</p>
        {report.preRestoreBackup && <p className="field-help">{formatTranslation(a.backup.preRestoreSaved, { file: report.preRestoreBackup })}</p>}
        <Counts counts={report.counts} />
        {report.schemaVersion.backup < report.schemaVersion.current && (
          <p className="field-help">{formatTranslation(a.backup.upgraded, { from: report.schemaVersion.backup, to: report.schemaVersion.current })}</p>
        )}
        {report.warningCodes.map((code) => <p className="field-help" key={code}>{a.backup.warnings[code]}</p>)}
        {report.ignoredSettings.length > 0 && <p className="field-help">{formatTranslation(a.backup.keptFromConfig, { keys: report.ignoredSettings.join(', ') })}</p>}
        <div className="form-actions"><button className="button button-primary" type="button" onClick={onRestored}>{a.backup.signInAgain}</button></div>
      </section>
    );
  }

  return (
    <div className="backup-sections">
      {error && (
        <div role="alert">
          <p className="error-note">{error}</p>
          {details && <details className="field-help"><summary>{a.backup.technicalDetails}</summary><p>{details}</p></details>}
        </div>
      )}
      <div role="status" aria-live="polite">{busy && <p className="field-help">{a.backup.working}</p>}</div>
      <section className="admin-panel" aria-labelledby="backup-download-title">
        <h2 id="backup-download-title">{a.backup.downloadTitle}</h2>
        <p className="field-help">{a.backup.downloadHelp}</p>
        <div className="form-actions">
          <button className="button button-primary button-with-icon" disabled={busy} type="button" onClick={() => void download()}>
            <DownloadIcon />{a.backup.download}
          </button>
        </div>
      </section>
      <section className="admin-panel" aria-labelledby="backup-restore-title">
        <h2 id="backup-restore-title">{a.backup.restoreTitle}</h2>
        <p className="field-help">{a.backup.restoreHelp}</p>
        <form className="stack-form" onSubmit={runPreview}>
          <label className="field"><span>{a.backup.file}</span>
            <input
              type="file"
              name="backup"
              accept="application/zip,.zip"
              onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setConfirmed(false); setError(''); setDetails(''); }}
            />
          </label>
          <div className="form-actions">
            <button className="button button-secondary button-with-icon" disabled={busy || !file} type="submit"><EyeIcon />{a.backup.preview}</button>
          </div>
        </form>
      </section>
      {preview && (
        <section className="admin-panel" aria-labelledby="backup-preview-title">
          <h2 id="backup-preview-title">{a.backup.previewTitle}</h2>
          <PreviewDetails preview={preview} />
          <label className="check-field">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            {a.backup.understand}
          </label>
          <div className="form-actions">
            <button className="button button-danger button-with-icon" disabled={busy || !confirmed} type="button" onClick={() => void restore()}>
              <UploadIcon />{a.backup.restore}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
