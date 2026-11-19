import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConfigError, ConfigSchema, EDITABLE_SETTINGS, loadConfigFile, parseConfig } from '../config.js';
import { loadStartup } from '../startup.js';

describe('config.yaml (CFG-3, CFG-5)', () => {
  it('defaults every key when the file is empty', () => {
    const config = parseConfig('');
    assert.deepEqual(config.server, { host: '127.0.0.1', port: 8082, trustProxy: false, logLevel: 'info' });
    assert.deepEqual(config.storage, { dataDir: 'data', databaseFile: 'agt-trivia.sqlite', logDatabaseFile: 'logs.sqlite', backupsDir: 'backups' });
    assert.deepEqual(config.backup, {});
    assert.deepEqual(config.rateLimits.adminUploads, { max: 120, windowMinutes: 15 });
    assert.deepEqual(config.logs, {});
    assert.deepEqual(config.site, {});
    assert.deepEqual(config.quiz, {});
  });

  it('treats sections whose keys are all commented out as absent', () => {
    assert.equal(parseConfig('server:\nsite:\n').server.port, 8082);
  });

  it('rejects an unknown key, naming it', () => {
    assert.throws(() => parseConfig('server:\n  prot: 1\n', { source: 'config.yaml' }), (error: unknown) => (
      error instanceof ConfigError && /^Invalid config\.yaml: server\.prot: /.test(error.message)
    ));
    assert.throws(() => parseConfig('nonsense: true\n'), /nonsense/);
  });

  it('rejects an invalid value, naming the key', () => {
    assert.throws(() => parseConfig('server:\n  port: 70000\n'), /server\.port/);
    assert.throws(() => parseConfig('site:\n  supportUrl: ftp://example.com\n'), /site\.supportUrl/);
    assert.throws(() => parseConfig('site:\n  title: ""\n'), /site\.title/);
    assert.throws(() => parseConfig('quiz:\n  shortLength: 0\n'), /quiz\.shortLength/);
    assert.throws(() => parseConfig('server:\n  logLevel: loud\n'), /server\.logLevel/);
  });

  it('rejects a long quiz that is not longer than the short one', () => {
    assert.throws(() => parseConfig('quiz:\n  shortLength: 20\n  longLength: 20\n'), /quiz\.longLength/);
    assert.equal(parseConfig('quiz:\n  shortLength: 20\n  longLength: 21\n').quiz.longLength, 21);
  });

  it('rejects YAML that is not a mapping', () => {
    assert.throws(() => parseConfig('- a\n- b\n'), ConfigError);
    assert.throws(() => parseConfig('server: [\n'), /not valid YAML/);
  });

  it('takes server.host from the file, then AGT_TRIVIA_SERVER_HOST, then 127.0.0.1', () => {
    assert.equal(parseConfig('', { defaultHost: '0.0.0.0' }).server.host, '0.0.0.0');
    assert.equal(parseConfig('server:\n  host: ::1\n', { defaultHost: '0.0.0.0' }).server.host, '::1');
  });

  it('accepts trustProxy as a boolean, an address or a list (SEC-4)', () => {
    assert.equal(parseConfig('server:\n  trustProxy: true\n').server.trustProxy, true);
    assert.equal(parseConfig('server:\n  trustProxy: 127.0.0.1\n').server.trustProxy, '127.0.0.1');
    assert.deepEqual(parseConfig('server:\n  trustProxy: [10.0.0.0/8, 127.0.0.1]\n').server.trustProxy, ['10.0.0.0/8', '127.0.0.1']);
  });

  it('means all defaults when the file is missing, and refuses a directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agt-trivia-config-'));
    try {
      const missing = loadConfigFile(join(directory, 'config.yaml'));
      assert.equal(missing.text, null);
      assert.equal(missing.config.server.port, 8082);
      mkdirSync(join(directory, 'folder.yaml'));
      assert.throws(() => loadConfigFile(join(directory, 'folder.yaml')), /is a directory/);
      writeFileSync(join(directory, 'bad.yaml'), 'server:\n  prot: 1\n');
      assert.throws(() => loadConfigFile(join(directory, 'bad.yaml')), new RegExp(`Invalid ${join(directory, 'bad.yaml').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: server\\.prot`));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/** Every `group.key` of the config schema (a rate limit's `max` and `windowMinutes` are one value). */
function schemaKeys(schema: { properties: Record<string, { properties?: Record<string, unknown> }> }): string[] {
  return Object.entries(schema.properties).flatMap(([group, value]) => Object.keys(value.properties ?? {}).map((key) => `${group}.${key}`));
}

describe('config.example.yaml (CFG-4)', async () => {
  const { readFileSync } = await import('node:fs');
  const example = readFileSync('config.example.yaml', 'utf8');

  it('is valid and, uncommented, equals the defaults', () => {
    assert.deepEqual(parseConfig(example), parseConfig(''));
    // Uncomment the key lines only (`# group:` and `#   key: value`), not the prose.
    const uncommented = example.split('\n').map((line) => line.replace(/^# ([a-z][A-Za-z]*:$|  [a-zA-Z]+: )/, '$1')).filter((line) => !/^\s*#/.test(line)).join('\n');
    const config = parseConfig(uncommented);
    assert.equal(config.server.port, 8082);
    for (const [key, definition] of Object.entries(EDITABLE_SETTINGS)) {
      const [group, name] = key.split('.');
      assert.deepEqual((config as unknown as Record<string, Record<string, unknown>>)[group][name], definition.default, `${key} shows its default`);
    }
  });

  it('documents every key, commented out', () => {
    for (const key of schemaKeys(ConfigSchema as never)) {
      const [group, name] = key.split('.');
      assert.match(example, new RegExp(`^# ${group}:$`, 'm'), `${group} is documented`);
      assert.match(example, new RegExp(`^#   ${name}: `, 'm'), `${key} is documented`);
    }
  });
});

describe('the environment (CFG-2, SRV-1)', () => {
  it('reads only AGT_TRIVIA_* variables, and empty values count as unset', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agt-trivia-env-'));
    try {
      const file = join(directory, 'config.yaml');
      writeFileSync(file, 'storage:\n  dataDir: /srv/trivia\n');
      const startup = loadStartup({ AGT_TRIVIA_CONFIG_FILE: file, AGT_TRIVIA_SERVER_HOST: '0.0.0.0', AGT_TRIVIA_STATIC_DIR: '' });
      assert.equal(startup.configFile.path, file);
      assert.equal(startup.configFile.config.server.host, '0.0.0.0');
      assert.equal(startup.databaseFile, '/srv/trivia/agt-trivia.sqlite');
      assert.match(startup.staticDir, /dist$/);
      assert.equal(loadStartup({ AGT_TRIVIA_CONFIG_FILE: join(directory, 'none.yaml'), CONFIG_FILE: file }).configFile.text, null);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
