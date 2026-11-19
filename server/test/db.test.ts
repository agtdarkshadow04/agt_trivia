import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { LOG_MIGRATIONS, openLogStore } from '../logs.js';
import { EXPECTED_TABLES, MIGRATIONS, missingTables, openDatabase, openSqlite, runMigrations, SCHEMA_VERSION, SchemaTooNewError, schemaVersion } from '../db.js';

describe('migrations (DATA-3, DATA-4)', () => {
  it('lists every migration file once, in order, numbered from 1', () => {
    const files = readdirSync('server/migrations').filter((file) => file.endsWith('.sql')).sort();
    assert.deepEqual(MIGRATIONS.map((migration) => `${migration.name}.sql`), files);
    MIGRATIONS.forEach((migration, index) => {
      assert.equal(migration.version, index + 1);
      assert.match(migration.name, new RegExp(`^${String(index + 1).padStart(4, '0')}_[a-z0-9_]+$`));
      assert.equal(migration.sql, readFileSync(join('server/migrations', `${migration.name}.sql`), 'utf8'));
      assert.doesNotMatch(migration.sql, /\b(BEGIN|COMMIT)\b/i, 'the runner wraps each migration in its transaction');
    });
    assert.equal(SCHEMA_VERSION, MIGRATIONS.length);
  });

  it('lists every log store migration file once, in order, and migrates an empty log store (LOG-1)', () => {
    const files = readdirSync('server/migrations/logs').filter((file) => file.endsWith('.sql')).sort();
    assert.deepEqual(LOG_MIGRATIONS.map((migration) => `${migration.name}.sql`), files);
    LOG_MIGRATIONS.forEach((migration, index) => assert.equal(migration.version, index + 1));
    const { store, applied } = openLogStore(':memory:');
    assert.equal(applied.length, LOG_MIGRATIONS.length);
    store.close();
  });

  it('migrates an empty database to the expected tables, once', () => {
    const sqlite = openSqlite(':memory:');
    assert.equal(runMigrations(sqlite).length, MIGRATIONS.length);
    assert.equal(schemaVersion(sqlite), SCHEMA_VERSION);
    assert.deepEqual(missingTables(sqlite), []);
    assert.deepEqual(runMigrations(sqlite), []);
    const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
    assert.deepEqual(tables, [...EXPECTED_TABLES].sort());
    sqlite.close();
  });

  it('migrates from each earlier schema version', () => {
    for (let version = 0; version < MIGRATIONS.length; version += 1) {
      const sqlite = openSqlite(':memory:');
      runMigrations(sqlite, MIGRATIONS.slice(0, version));
      assert.equal(schemaVersion(sqlite), version);
      runMigrations(sqlite);
      assert.equal(schemaVersion(sqlite), SCHEMA_VERSION);
      assert.deepEqual(missingTables(sqlite), []);
      sqlite.close();
    }
  });

  it('refuses a newer schema without changing it (SRV-8, DATA-4)', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agt-trivia-db-'));
    try {
      const file = join(directory, 'trivia.sqlite');
      const sqlite = openSqlite(file);
      sqlite.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
      sqlite.close();
      assert.throws(() => openDatabase(file), (error: unknown) => error instanceof SchemaTooNewError && /newer than this version/.test(error.message));
      const after = openSqlite(file);
      assert.equal(schemaVersion(after), SCHEMA_VERSION + 1);
      assert.equal((after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n, 0);
      after.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('opens a file with WAL, foreign keys and a busy timeout, creating its directory (DATA-5, DATA-10)', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agt-trivia-db-'));
    try {
      const { db, applied, schemaVersion: version } = openDatabase(join(directory, 'nested', 'trivia.sqlite'));
      assert.equal(applied.length, MIGRATIONS.length);
      assert.equal(version, SCHEMA_VERSION);
      assert.equal(db.connection.pragma('journal_mode', { simple: true }), 'wal');
      assert.equal(db.connection.pragma('foreign_keys', { simple: true }), 1);
      assert.equal(db.connection.pragma('busy_timeout', { simple: true }), 5000);
      db.ping();
      db.close();
      assert.equal(openDatabase(join(directory, 'nested', 'trivia.sqlite')).applied.length, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('gives every table created_at and updated_at (DATA-8)', () => {
    const sqlite = openSqlite(':memory:');
    runMigrations(sqlite);
    for (const table of EXPECTED_TABLES) {
      const columns = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
      assert.ok(columns.includes('created_at') && columns.includes('updated_at'), table);
    }
    sqlite.close();
  });
});
