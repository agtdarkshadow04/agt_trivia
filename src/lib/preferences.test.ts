import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultPreferences, readPreferences, settingsKey, writePreference } from './preferences.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe('preferences (FE-3, I18N-4, A11Y-6)', () => {
  it('uses one agt_trivia_settings key and English at 1× by default', () => {
    assert.equal(settingsKey, 'agt_trivia_settings');
    assert.deepEqual(readPreferences(memoryStorage()), defaultPreferences);
    assert.deepEqual(defaultPreferences, { language: 'en', fontScale: '1', timeZone: 'auto' });
  });

  it('reads defensively: invalid JSON, wrong types and unknown values give the defaults', () => {
    assert.deepEqual(readPreferences(memoryStorage({ [settingsKey]: '{not json' })), defaultPreferences);
    assert.deepEqual(readPreferences(memoryStorage({ [settingsKey]: '[1,2]' })), defaultPreferences);
    assert.deepEqual(readPreferences(memoryStorage({ [settingsKey]: '{"language":"xx","fontScale":"3"}' })), defaultPreferences);
    assert.deepEqual(readPreferences(memoryStorage({ [settingsKey]: '{"language":"ja","fontScale":"2","timeZone":"+05:30"}' })), { language: 'ja', fontScale: '2', timeZone: '+05:30' });
    assert.equal(readPreferences(memoryStorage({ [settingsKey]: '{"timeZone":"Mars/Olympus"}' })).timeZone, 'auto');
    assert.deepEqual(readPreferences(null), defaultPreferences);
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    assert.deepEqual(readPreferences(throwing), defaultPreferences);
    assert.doesNotThrow(() => writePreference('language', 'fr', throwing));
  });

  it('writes one preference and keeps the others', () => {
    const storage = memoryStorage({ [settingsKey]: '{"fontScale":"1.5","other":true}' });
    writePreference('language', 'de', storage);
    assert.deepEqual(JSON.parse(storage.values.get(settingsKey)!), { other: true, language: 'de', fontScale: '1.5', timeZone: 'auto' });
  });
});
