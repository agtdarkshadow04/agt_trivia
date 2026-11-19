import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { errorText } from '../lib/errors';
import { preferencesChangedEvent, readPreferences, writePreference, type Preferences } from '../lib/preferences';
import { getTranslations, localeTag, type Locale, type Translations } from '../translations';

/**
 * The reader's language and font scale (I18N-4, A11Y-6), from the shared
 * `agt_trivia_settings` preferences, for both entries. It keeps `<html lang>`
 * and `data-font-scale` in step with them.
 */

export interface I18nValue {
  locale: Locale;
  /** The BCP 47 tag for `Intl` and `lang` (`pt-BR` for `pt`). */
  tag: string;
  t: Translations;
  preferences: Preferences;
  /** The reader's text for any error (I18N-6). */
  error(cause: unknown): string;
}

function i18nValue(preferences: Preferences): I18nValue {
  const t = getTranslations(preferences.language);
  return { locale: preferences.language, tag: localeTag(preferences.language), t, preferences, error: (cause) => errorText(cause, t) };
}

/** English with the default preferences, for a component rendered without the provider. */
const I18nContext = createContext<I18nValue>(i18nValue(readPreferences(null)));

/** Stores a preference and tells every open page (both entries) to follow it. */
export function changePreference<K extends keyof Preferences>(name: K, value: Preferences[K]) {
  writePreference(name, value);
  window.dispatchEvent(new Event(preferencesChangedEvent));
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(() => readPreferences());

  useEffect(() => {
    const refresh = () => setPreferences(readPreferences());
    window.addEventListener(preferencesChangedEvent, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(preferencesChangedEvent, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = localeTag(preferences.language);
    document.documentElement.dataset.fontScale = preferences.fontScale;
  }, [preferences]);

  const value = useMemo(() => i18nValue(preferences), [preferences]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
