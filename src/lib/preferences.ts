import { isLocale, type Locale } from '../translations.js';

/**
 * User preferences (FE-3, I18N-4): one JSON object in
 * `localStorage["agt_trivia_settings"]`, shared by the public UI and the admin
 * dashboard. Only preferences, never API data; read defensively, so a missing,
 * invalid or blocked store gives the defaults field by field.
 */

export const settingsKey = 'agt_trivia_settings';

/** The font scale (A11Y-6): every size is in `rem`, so this scales all text. */
export const fontScales = ['1', '1.25', '1.5', '1.75', '2'] as const;

export type FontScale = typeof fontScales[number];

export interface Preferences {
  /** I18N-1; English unless the reader chooses another (no auto-detection, I18N-4). */
  language: Locale;
  fontScale: FontScale;
}

export const defaultPreferences: Preferences = { language: 'en', fontScale: '1' };

/** Sent on `window` when a preference changes, so open pages can follow it. */
export const preferencesChangedEvent = 'agt_trivia_preferences_changed';

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

/** `localStorage`, or null where it is missing or access throws (private modes, blocked storage). */
export function browserStorage(): KeyValueStore | null {
  try {
    return (globalThis as { localStorage?: KeyValueStore }).localStorage ?? null;
  } catch {
    return null;
  }
}

function readStored(storage: KeyValueStore | null): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(storage?.getItem(settingsKey) ?? 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function readPreferences(storage = browserStorage()): Preferences {
  const stored = readStored(storage);
  return {
    language: isLocale(stored.language) ? stored.language : defaultPreferences.language,
    fontScale: fontScales.includes(stored.fontScale as FontScale) ? stored.fontScale as FontScale : defaultPreferences.fontScale,
  };
}

/** Stores one preference, keeping keys other versions may have stored; a store that refuses the write only loses it. */
export function writePreference<K extends keyof Preferences>(name: K, value: Preferences[K], storage = browserStorage()) {
  try {
    storage?.setItem(settingsKey, JSON.stringify({ ...readStored(storage), ...readPreferences(storage), [name]: value }));
  } catch {
    // Storage full or blocked: the preference applies until the page is reloaded.
  }
}
