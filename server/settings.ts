import { fieldError } from '../src/lib/errors.js';
import { quizLengthsError } from '../src/lib/validation.js';
import { isSettingKey, validSetting, type SettingKey } from './config.js';
import { lockedSettingKeys, settingStates, settingValues, type AppContext, type SettingState } from './context.js';
import { HttpError } from './http.js';
import { readSettings, writeSettings } from './repository/settings.js';
import { deleteIamMemberSessions } from './repository/members.js';

/** The dashboard settings (CFG-6..CFG-8): the states the Settings tab shows, and its updates. */

export function currentSettings(context: AppContext): SettingState[] {
  return settingStates(context.config, readSettings(context.db));
}

/** The keys and their old and new values, for the audit summary (LOG-14, #12). */
export interface SettingsChange {
  key: SettingKey;
  from: unknown;
  to: unknown;
}

/**
 * `PUT /api/admin/settings` (CFG-8). Rejects the whole request, changing
 * nothing, when a key is not in `EDITABLE_SETTINGS` (`400 unknown_setting`), is
 * set in config.yaml (`409 defined_in_config`) or gets a value its schema or a
 * rule between settings does not allow (`400 invalid_setting`). `null` resets
 * a key to its default. Runs inside the route's data write.
 */
export function updateSettings(context: AppContext, values: Readonly<Record<string, unknown>>): { settings: SettingState[]; changes: SettingsChange[] } {
  const entries = Object.entries(values);
  const unknown = entries.find(([key]) => !isSettingKey(key));
  if (unknown) throw new HttpError(400, 'unknown_setting', `${unknown[0]} is not a setting that can be changed from the dashboard.`, { params: { key: unknown[0] } });
  const locked = new Set<string>(lockedSettingKeys(context.config));
  const fromFile = entries.find(([key]) => locked.has(key));
  if (fromFile) {
    throw new HttpError(409, 'defined_in_config', `${fromFile[0]} is defined in the configuration file and cannot be changed from the dashboard.`, { params: { key: fromFile[0] } });
  }
  const invalid = entries.filter(([key, value]) => value !== null && !validSetting(key as SettingKey, value));
  if (invalid.length) {
    const [key] = invalid[0];
    throw new HttpError(400, 'invalid_setting', `${key} has a value that is not allowed.`, {
      params: { key },
      fields: invalid.map(([field]) => fieldError(field, 'not_allowed', `${field} has a value that is not allowed.`)),
    });
  }

  const stored = readSettings(context.db);
  const before = settingValues(context.config, stored);
  const next = new Map(stored);
  for (const [key, value] of entries) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  const after = settingValues(context.config, next);
  const lengths = quizLengthsError(after['quiz.shortLength'], after['quiz.longLength']);
  if (lengths) {
    // Name the field the request changed, so the form shows the error where the Admin typed.
    const field = 'quiz.longLength' in values || !('quiz.shortLength' in values) ? 'quiz.longLength' : 'quiz.shortLength';
    throw new HttpError(400, 'invalid_setting', lengths.message, { params: { key: field }, fields: [{ ...lengths, field }] });
  }

  writeSettings(context.db, values);
  // Switching AGT sign-in off ends every AGT member's session at once (AUTH-4, #18).
  if (!after['iam.enabled']) deleteIamMemberSessions(context.db.connection);
  const changes = (Object.keys(values) as SettingKey[])
    .filter((key) => before[key] !== after[key])
    .map((key) => ({ key, from: before[key], to: after[key] }));
  return { settings: currentSettings(context), changes };
}
