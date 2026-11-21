import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/** SPEC-2: the pinned spec copy is `agt-webapp-spec.md` at tag v6.0.3, byte for byte, and AGENTS.md names it. */
describe('the pinned spec copy (SPEC-2, DOC-2)', () => {
  it('is the v6.0.3 release file', () => {
    const sha256 = createHash('sha256').update(readFileSync('docs/agt-webapp-spec.md')).digest('hex');
    assert.equal(sha256, '2e15df4dec9221e76b8771b9a351e98e2e9ee24c15c8d14765f14d9067d68ec6');
  });

  it('registers the trivia slug and its default port (NAME-1)', () => {
    assert.match(readFileSync('docs/agt-webapp-spec.md', 'utf8'),
      /\| `trivia` \| AGT Galactic Trivia \| `agtdarkshadow04\/agt_trivia` \| 8082 \| SQLite \|/);
  });

  it('is named with its version and tag in AGENTS.md, and CLAUDE.md only imports AGENTS.md', () => {
    const agents = readFileSync('AGENTS.md', 'utf8');
    assert.match(agents, /\[AGT Web Application Specification\]\(docs\/agt-webapp-spec\.md\) v6\.0\.3/);
    assert.match(agents, /agtdarkshadow04\/agt_webapp_specification@v6\.0\.3/);
    assert.equal(readFileSync('CLAUDE.md', 'utf8').trim(), '@AGENTS.md');
  });
});
