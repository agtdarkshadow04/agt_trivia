import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { fieldError } from '../lib/errors';
import { errorsOf, quizLengthsError } from '../lib/validation';
import { formatTranslation } from '../translations';
import { formErrors, noFormErrors, TextField } from '../components/Field';
import { listRankedCategories, listSettings, saveRankedCategories, updateSettings, type IamStatus, type RankedCategory, type SettingState, type SettingValue } from './api';
import { useAdminI18n } from './context';
import type { AdminTranslations } from './i18n';

type Key = 'site.title' | 'site.supportUrl' | 'quiz.shortLength' | 'quiz.longLength' | 'leaderboards.enabled' | 'leaderboards.size'
  | 'ranked.enabled' | 'ranked.questionsPerRun' | 'ranked.secondsPerQuestion' | 'ranked.ratingRuns' | 'ranked.cooldownDays' | 'ranked.boardSize'
  | 'backup.maxZipBytes' | 'backup.maxUncompressedBytes' | 'backup.maxEntries' | 'iam.enabled'
  | 'logs.serverRetentionDays' | 'logs.serverMaxEntries' | 'logs.auditRetentionDays' | 'logs.auditMaxEntries';

/** The form's fields, grouped as in config.yaml (CFG-6). */
const groups: { title: (a: AdminTranslations) => string; help?: (a: AdminTranslations) => string; keys: { key: Key; type: 'text' | 'url' | 'number' | 'checkbox' }[] }[] = [
  { title: (a) => a.settings.site, keys: [{ key: 'site.title', type: 'text' }, { key: 'site.supportUrl', type: 'url' }] },
  { title: (a) => a.settings.quiz, help: (a) => a.settings.quizHelp, keys: [{ key: 'quiz.shortLength', type: 'number' }, { key: 'quiz.longLength', type: 'number' }] },
  {
    title: (a) => a.settings.leaderboards,
    help: (a) => a.settings.leaderboardsHelp,
    keys: [{ key: 'leaderboards.enabled', type: 'checkbox' }, { key: 'leaderboards.size', type: 'number' }],
  },
  {
    title: (a) => a.settings.ranked,
    help: (a) => a.settings.rankedHelp,
    keys: [
      { key: 'ranked.enabled', type: 'checkbox' }, { key: 'ranked.questionsPerRun', type: 'number' }, { key: 'ranked.secondsPerQuestion', type: 'number' },
      { key: 'ranked.ratingRuns', type: 'number' }, { key: 'ranked.cooldownDays', type: 'number' }, { key: 'ranked.boardSize', type: 'number' },
    ],
  },
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
  'leaderboards.enabled': a.settings.leaderboardsEnabled,
  'leaderboards.size': a.settings.leaderboardsSize,
  'ranked.enabled': a.settings.rankedEnabled,
  'ranked.questionsPerRun': a.settings.rankedQuestionsPerRun,
  'ranked.secondsPerQuestion': a.settings.rankedSecondsPerQuestion,
  'ranked.ratingRuns': a.settings.rankedRatingRuns,
  'ranked.cooldownDays': a.settings.rankedCooldownDays,
  'ranked.boardSize': a.settings.rankedBoardSize,
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

/**
 * Which categories ranked runs draw from (#66): every category, ticked unless
 * the Admin left it out. Saving sends only the categories that changed.
 */
function RankedCategories() {
  const { t, a } = useAdminI18n();
  const id = useId();
  const [categories, setCategories] = useState<RankedCategory[] | null>(null);
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const show = useCallback((next: RankedCategory[]) => {
    setCategories(next);
    setDraft(Object.fromEntries(next.map((category) => [category.id, category.ranked])));
  }, []);
  useEffect(() => {
    listRankedCategories().then(show, (cause: unknown) => setError(formErrors(cause, t).form ?? ''));
  }, [show, t]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!categories) return;
    setSaved(false);
    setError('');
    const changed = categories.filter((category) => draft[category.id] !== category.ranked).map((category) => ({ id: category.id, ranked: draft[category.id] }));
    if (!changed.length) return;
    setBusy(true);
    try {
      show((await saveRankedCategories(changed)).categories);
      setSaved(true);
    } catch (cause) {
      setError(formErrors(cause, t).form ?? '');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack-form ranked-categories" noValidate aria-labelledby={`${id}-title`} onSubmit={(event) => void submit(event)}>
      <fieldset className="settings-group">
        <legend id={`${id}-title`}>{a.settings.rankedCategories}</legend>
        <p className="field-help">{a.settings.rankedCategoriesHelp}</p>
        {error && <p className="error-note" role="alert">{error}</p>}
        <div role="status" aria-live="polite">
          {!categories && !error && <p>{a.settings.rankedCategoriesLoading}</p>}
          {saved && <p className="success-note">{a.settings.rankedCategoriesSaved}</p>}
        </div>
        {categories?.length === 0 && <p className="field-help">{a.settings.rankedCategoriesNone}</p>}
        {categories?.map((category) => (
          <label key={category.id} className="check-field">
            <input
              type="checkbox"
              checked={draft[category.id] ?? category.ranked}
              onChange={(event) => setDraft((current) => ({ ...current, [category.id]: event.target.checked }))}
            />
            {formatTranslation(a.settings.rankedCategoryCount, { name: category.name, count: category.questionCount })}
          </label>
        ))}
      </fieldset>
      {categories && categories.length > 0 && (
        <div className="form-actions">
          <button className="button button-primary" type="submit" disabled={busy}>{a.settings.rankedCategoriesSave}</button>
        </div>
      )}
    </form>
  );
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
      <RankedCategories />
    </section>
  );
}
