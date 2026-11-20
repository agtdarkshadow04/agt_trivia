import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { fieldError } from '../lib/errors';
import { errorsOf, quizLengthsError } from '../lib/validation';
import { formatTranslation } from '../translations';
import { formErrors, noFormErrors, TextField } from '../components/Field';
import { listSettings, updateSettings, type IamStatus, type SettingState, type SettingValue } from './api';
import { useAdminI18n } from './context';
import type { AdminTranslations } from './i18n';

type Key = 'site.title' | 'site.supportUrl' | 'quiz.shortLength' | 'quiz.longLength'
  | 'backup.maxZipBytes' | 'backup.maxUncompressedBytes' | 'backup.maxEntries' | 'iam.enabled'
  | 'logs.serverRetentionDays' | 'logs.serverMaxEntries' | 'logs.auditRetentionDays' | 'logs.auditMaxEntries';

/** The form's fields, grouped as in config.yaml (CFG-6). */
const groups: { title: (a: AdminTranslations) => string; help?: (a: AdminTranslations) => string; keys: { key: Key; type: 'text' | 'url' | 'number' | 'checkbox' }[] }[] = [
  { title: (a) => a.settings.site, keys: [{ key: 'site.title', type: 'text' }, { key: 'site.supportUrl', type: 'url' }] },
  { title: (a) => a.settings.quiz, help: (a) => a.settings.quizHelp, keys: [{ key: 'quiz.shortLength', type: 'number' }, { key: 'quiz.longLength', type: 'number' }] },
  {
    title: (a) => a.settings.backupLimits,
    keys: [{ key: 'backup.maxZipBytes', type: 'number' }, { key: 'backup.maxUncompressedBytes', type: 'number' }, { key: 'backup.maxEntries', type: 'number' }],
  },
  { title: (a) => a.settings.iam, help: (a) => a.settings.iamHelp, keys: [{ key: 'iam.enabled', type: 'checkbox' }] },
  {
    title: (a) => a.settings.logRetention,
    help: (a) => a.settings.logRetentionHelp,
    keys: [
      { key: 'logs.serverRetentionDays', type: 'number' }, { key: 'logs.serverMaxEntries', type: 'number' },
      { key: 'logs.auditRetentionDays', type: 'number' }, { key: 'logs.auditMaxEntries', type: 'number' },
    ],
  },
];

const labels = (a: AdminTranslations): Record<Key, string> => ({
  'site.title': a.settings.siteTitle,
  'site.supportUrl': a.settings.supportUrl,
  'quiz.shortLength': a.settings.quizShortLength,
  'quiz.longLength': a.settings.quizLongLength,
  'backup.maxZipBytes': a.settings.maxZipBytes,
  'backup.maxUncompressedBytes': a.settings.maxUncompressedBytes,
  'backup.maxEntries': a.settings.maxEntries,
  'iam.enabled': a.settings.iamEnabled,
  'logs.serverRetentionDays': a.settings.serverRetentionDays,
  'logs.serverMaxEntries': a.settings.serverMaxEntries,
  'logs.auditRetentionDays': a.settings.auditRetentionDays,
  'logs.auditMaxEntries': a.settings.auditMaxEntries,
});

/** Where the operator sets what AGT sign-in still needs: config.yaml keys and the .env secret are names, never translated. */
const iamMissingName = (missing: IamStatus['missing'][number]) => (missing === 'apiKey' ? 'AGT_TRIVIA_IAM_API_KEY' : `iam.${missing}`);

/** Where a value comes from, read-only for keys config.yaml sets (CFG-9). */
function sourceText(state: SettingState, a: AdminTranslations) {
  const template = state.locked ? a.settings.fromConfig : state.source === 'dashboard' ? a.settings.fromDashboard : a.settings.fromDefault;
  return formatTranslation(template, { key: state.key });
}

/** UI-8 Settings (CFG-6, CFG-9): the dashboard-editable settings; config.yaml always wins. */
export function SettingsPanel() {
  const { t, a } = useAdminI18n();
  const id = useId();
  const [states, setStates] = useState<SettingState[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState(noFormErrors);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const [iam, setIam] = useState<IamStatus | null>(null);
  const show = useCallback((next: SettingState[], status: IamStatus) => {
    setStates(next);
    setIam(status);
    setDraft(Object.fromEntries(next.map((state) => [state.key, String(state.value)])));
  }, []);

  const load = useCallback(async () => {
    setErrors(noFormErrors);
    try {
      const loaded = await listSettings();
      show(loaded.settings, loaded.iam);
    } catch (cause) {
      setErrors(formErrors(cause, t));
    }
  }, [show, t]);

  useEffect(() => { void load(); }, [load]);

  const byKey = new Map((states ?? []).map((state) => [state.key, state]));
  const value = (key: Key): SettingValue => {
    const state = byKey.get(key)!;
    if (typeof state.default === 'boolean') return draft[key] === 'true';
    return typeof state.default === 'number' ? Number(draft[key]) : draft[key];
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!states) return;
    setSaved(false);
    const changed: Record<string, SettingValue> = {};
    for (const state of states) {
      if (state.locked) continue;
      const next = value(state.key as Key);
      if (next !== state.value) changed[state.key] = next;
    }
    // FE-6: the shared rule between the two lengths, and whole numbers, before the server checks them again.
    const numberKeys = groups.flatMap((group) => group.keys).filter((entry) => entry.type === 'number').map((entry) => entry.key);
    const problems = errorsOf(
      ...numberKeys.map((key) => (
        Number.isInteger(value(key)) ? null : fieldError(key, 'invalid_format', `${key} must be a whole number.`)
      )),
      Number.isInteger(value('quiz.shortLength')) && Number.isInteger(value('quiz.longLength'))
        ? quizLengthsError(value('quiz.shortLength') as number, value('quiz.longLength') as number)
        : null,
    );
    setErrors(formErrors(problems, t, labels(a)));
    if (problems.length || Object.keys(changed).length === 0) return;
    setBusy(true);
    try {
      const updated = await updateSettings(changed);
      show(updated.settings, updated.iam);
      setSaved(true);
    } catch (cause) {
      setErrors(formErrors(cause, t, labels(a)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-panel" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{a.settings.title}</h2>
      <p className="field-help">{a.settings.intro}</p>
      {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
      <div role="status" aria-live="polite">
        {!states && !errors.form && <p>{a.settings.loading}</p>}
        {saved && <p className="success-note">{a.settings.saved}</p>}
      </div>
      {states && (
        <form className="stack-form" noValidate onSubmit={(event) => void submit(event)}>
          {groups.map((group) => (
            <fieldset key={group.keys[0].key} className="settings-group">
              <legend>{group.title(a)}</legend>
              {group.help && <p className="field-help">{group.help(a)}</p>}
              {group.keys.map(({ key, type }) => {
                const state = byKey.get(key);
                if (!state) return null;
                const help = `${sourceText(state, a)} · ${formatTranslation(a.settings.defaultValue, { value: String(state.default) })}`;
                if (type === 'checkbox') {
                  return (
                    <div key={key} className="settings-check">
                      <label className="check-field">
                        <input
                          type="checkbox"
                          name={key}
                          checked={draft[key] === 'true'}
                          disabled={state.locked}
                          aria-describedby={`${id}-${key}-help`}
                          onChange={(event) => setDraft((current) => ({ ...current, [key]: String(event.target.checked) }))}
                        />
                        {labels(a)[key]}
                      </label>
                      <span id={`${id}-${key}-help`} className="field-help">{help}</span>
                      {key === 'iam.enabled' && iam && (
                        <p className={iam.missing.length ? 'admin-notice' : 'field-help'}>
                          {iam.missing.length
                            ? formatTranslation(a.settings.iamMissing, { missing: iam.missing.map(iamMissingName).join(', ') })
                            : a.settings.iamReady}
                        </p>
                      )}
                    </div>
                  );
                }
                return (
                  <TextField
                    key={key}
                    label={labels(a)[key]}
                    name={key}
                    type={type}
                    inputMode={type === 'number' ? 'numeric' : undefined}
                    value={draft[key] ?? ''}
                    readOnly={state.locked}
                    onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
                    help={help}
                    error={errors.fields[key]}
                  />
                );
              })}
            </fieldset>
          ))}
          <div className="form-actions">
            <button className="button button-primary" type="submit" disabled={busy}>{a.settings.save}</button>
            <button className="button button-secondary" type="button" disabled={busy} onClick={() => { setSaved(false); setErrors(noFormErrors); if (iam) show(states, iam); }}>{a.settings.cancel}</button>
          </div>
        </form>
      )}
    </section>
  );
}
