import { useId } from 'react';
import { offsetLabel, TIME_ZONE_OFFSETS, type TimeZoneSetting } from '../lib/format';
import { fontScales, type FontScale, type Preferences } from '../lib/preferences';
import { formatTranslation, LOCALES, type Locale } from '../translations';
import { changePreference, useI18n } from './I18n';

/**
 * The language, time zone and text-size controls (I18N-4, A11Y-6), shared by
 * the public settings dialog and the admin preferences. A page that shows no
 * times can leave the time zone out (`timeZone={false}`).
 */
export function DisplaySettings({ timeZone = true }: { timeZone?: boolean }) {
  const { t, preferences } = useI18n();
  const id = useId();
  const change = <K extends keyof Preferences>(name: K, value: Preferences[K]) => changePreference(name, value);
  return (
    <div className="settings-controls">
      <label className="field">
        <span>{t.settings.language}</span>
        <select value={preferences.language} onChange={(event) => change('language', event.target.value as Locale)}>
          {LOCALES.map((locale) => <option key={locale.value} value={locale.value} lang={locale.tag}>{locale.flag} {locale.label}</option>)}
        </select>
      </label>
      {timeZone && <label className="field">
        <span>{t.settings.timeZone}</span>
        <select value={preferences.timeZone} onChange={(event) => change('timeZone', event.target.value as TimeZoneSetting)}>
          <option value="auto">{t.settings.timeZoneAuto}</option>
          {TIME_ZONE_OFFSETS.map((offset) => <option key={offset} value={offset}>{offsetLabel(offset)}</option>)}
        </select>
      </label>}
      <label className="field">
        <span>{t.settings.textSize}</span>
        <select value={preferences.fontScale} onChange={(event) => change('fontScale', event.target.value as FontScale)} aria-describedby={`${id}-scale-help`}>
          {fontScales.map((scale) => (
            <option key={scale} value={scale}>{scale === '1' ? formatTranslation(t.settings.textSizeDefault, { scale }) : `${scale}×`}</option>
          ))}
        </select>
      </label>
      <p id={`${id}-scale-help`} className="field-help settings-help">{t.settings.textSizeHelp}</p>
    </div>
  );
}
