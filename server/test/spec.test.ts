import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/** SPEC-2: the pinned spec copy is `agt-webapp-spec.md` at tag v6.0.1, byte for byte, and AGENTS.md names it. */
describe('the pinned spec copy (SPEC-2, DOC-2)', () => {
  it('is the v6.0.1 release file', () => {
    const sha256 = createHash('sha256').update(readFileSync('docs/agt-webapp-spec.md')).digest('hex');
    assert.equal(sha256, '51efb8b04947afcac880fe33e416127b45cff78c471590ec7f9546b683e4b506');
    assert.match(readFileSync('docs/agt-webapp-spec.md', 'utf8'), /\| \*\*Spec version\*\* \| 6\.0\.1 \|/);
  });

  it('is named with its version and tag in AGENTS.md, and CLAUDE.md only imports AGENTS.md', () => {
    const agents = readFileSync('AGENTS.md', 'utf8');
    assert.match(agents, /\[AGT Web Application Specification\]\(docs\/agt-webapp-spec\.md\) v6\.0\.1/);
    assert.match(agents, /agtdarkshadow04\/agt_webapp_specification@v6\.0\.1/);
    assert.equal(readFileSync('CLAUDE.md', 'utf8').trim(), '@AGENTS.md');
  });
});
