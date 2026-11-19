import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';
import { lockedSettingKeys, setting, settingStates } from '../context.js';
import { withDataWrite } from '../dataWrite.js';
import { readSettings, writeSettings } from '../repository/settings.js';
import { testContext } from './helpers.js';

describe('setting precedence (CFG-7)', () => {
  it('takes the config file over the dashboard over the default', () => {
    const stored = new Map<string, unknown>([['site.title', 'From the dashboard'], ['quiz.shortLength', 12]]);
    const config = parseConfig('site:\n  title: From the file\n');
    assert.deepEqual(setting(config, stored, 'site.title'), {
      key: 'site.title', value: 'From the file', source: 'config', locked: true, default: 'AGT Galactic Trivia',
      description: 'Name shown in the header and the browser title.',
    });
    assert.equal(setting(config, stored, 'quiz.shortLength').value, 12);
    assert.equal(setting(config, stored, 'quiz.shortLength').source, 'dashboard');
    assert.equal(setting(config, stored, 'quiz.longLength').value, 30);
    assert.equal(setting(config, stored, 'quiz.longLength').source, 'default');
    assert.deepEqual(lockedSettingKeys(config), ['site.title']);
  });

  it('ignores a stored value the schema does not allow', () => {
    const state = setting(parseConfig(''), new Map([['quiz.shortLength', 'ten']]), 'quiz.shortLength');
    assert.equal(state.value, 10);
    assert.equal(state.source, 'default');
  });

  it('lists every setting in EDITABLE_SETTINGS order', () => {
    assert.deepEqual(settingStates(parseConfig(''), new Map()).map((state) => state.key), ['site.title', 'site.supportUrl', 'quiz.shortLength', 'quiz.longLength']);
  });
});

describe('the settings table', () => {
  const context = testContext();
  after(() => context.close());

  it('stores, replaces and removes values as JSON, only inside a data write (BAK-8)', () => {
    assert.throws(() => writeSettings(context.db, { 'site.title': 'Nope' }), /outside withDataWrite/);
    assert.equal(readSettings(context.db).size, 0);
    withDataWrite(() => writeSettings(context.db, { 'site.title': 'First', 'quiz.shortLength': 5 }));
    withDataWrite(() => writeSettings(context.db, { 'site.title': 'Second' }));
    assert.deepEqual([...readSettings(context.db)], [['quiz.shortLength', 5], ['site.title', 'Second']]);
    withDataWrite(() => writeSettings(context.db, { 'site.title': null }));
    assert.deepEqual([...readSettings(context.db)], [['quiz.shortLength', 5]]);
    const row = context.db.connection.prepare('SELECT created_at, updated_at FROM settings').get() as { created_at: string; updated_at: string };
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('GET /api/settings/public (CFG-10)', () => {
  it('returns the effective public values, config file first', async () => {
    const context = testContext('quiz:\n  longLength: 40\n');
    withDataWrite(() => writeSettings(context.db, { 'site.title': 'Trivia Night', 'quiz.longLength': 99 }));
    const app = buildApp(context);
    try {
      const response = await app.inject('/api/settings/public');
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        siteTitle: 'Trivia Night', supportUrl: 'https://www.nms-agt.com/support', quizShortLength: 10, quizLongLength: 40,
      });
    } finally {
      await app.close();
      context.close();
    }
  });
});
