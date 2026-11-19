import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ADMINTRANSLATIONS, getAdminTranslations } from '../admin/i18n.js';
import { tableProblems } from './translationChecks.js';

describe('admin translations (I18N-2, I18N-3)', () => {
  it('has every English key, non-empty and translated, in every locale', () => {
    assert.deepEqual(tableProblems(ADMINTRANSLATIONS, ADMINTRANSLATIONS.en), []);
  });

  it('names this app\'s setup password variable', () => {
    for (const table of Object.values(ADMINTRANSLATIONS)) {
      assert.match(table.setup.unavailable + table.setup.intro + table.app.setupPasswordStillSet, /AGT_TRIVIA_SETUP_PASSWORD/);
      assert.doesNotMatch(JSON.stringify(table), /KNOWLEDGE_BASE|knowledge base/i);
    }
  });

  it('falls back to English for an unknown locale', () => {
    assert.equal(getAdminTranslations('xx'), ADMINTRANSLATIONS.en);
  });
});
