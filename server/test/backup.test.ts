import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { buildApp } from '../app.js';
import { lineDiff, markerFile, type BackupHooks } from '../backup.js';
import { readSettings } from '../repository/settings.js';
import { isSafePath, openSafeZip } from '../zip.js';
import { adminCookie, testContext, type TestContextOptions } from './helpers.js';

/** Backups and restores (§12), their checks (BAK-3, SEC-10), the operation lock (BAK-8) and failures (BAK-10, BAK-11): TEST-4. */

const csrf = { 'x-agt-request': '1' };

function server(config = '', options: TestContextOptions & { hooks?: BackupHooks } = {}) {
  const context = { ...testContext(config, { file: true, ...options }), backupHooks: options.hooks };
  const app = buildApp(context);
  return { context, app, close: async () => { await app.close(); context.close(); } };
}

type Server = ReturnType<typeof server>;

async function setTitle({ app }: Server, cookie: string, title: string) {
  return app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie, ...csrf }, payload: { values: { 'site.title': title } } });
}

function storedTitle({ context }: Server) {
  return readSettings(context.db).get('site.title');
}

async function download({ app }: Server, cookie: string) {
  const response = await app.inject({ url: '/api/admin/backup', headers: { cookie } });
  assert.equal(response.statusCode, 200, response.body);
  return response.rawPayload;
}

/** A `multipart/form-data` body with the `action` field and, unless null, the `backup` file. */
function multipart(action: string, file: Buffer | null) {
  const boundary = `----agt${randomUUID()}`;
  const parts: Buffer[] = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="action"\r\n\r\n${action}\r\n`)];
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="backup"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`), file, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function upload({ app }: Server, cookie: string, action: 'preview' | 'restore', file: Buffer | null) {
  const body = multipart(action, file);
  return app.inject({ method: 'POST', url: '/api/admin/restore', headers: { cookie, ...csrf, ...body.headers }, payload: body.payload });
}

/** The entries of a ZIP buffer. */
async function readZip(buffer: Buffer): Promise<Map<string, Buffer>> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, file) => (error ? reject(error) : resolve(file))));
  const entries = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (entry: yauzl.Entry) => {
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
      });
    });
    zip.on('end', resolve);
    zip.on('error', reject);
    zip.readEntry();
  });
  return entries;
}

/** A ZIP buffer of `entries`, in order. */
async function writeZipBuffer(entries: [string, Buffer][]) {
  const zip = new yazl.ZipFile();
  for (const [path, data] of entries) zip.addBuffer(data, path);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/**
 * Rebuilds a backup: `change` may edit the manifest, the files and the
 * database (opened from a temporary copy); unless `keepManifest`, the
 * manifest's files list is recomputed from the result.
 */
async function rebuild(
  backup: Buffer,
  dir: string,
  change: { manifest?: (manifest: Record<string, unknown>) => void; files?: (files: Map<string, Buffer>) => void; database?: (sqlite: BetterSqlite3.Database) => void; keepManifest?: boolean },
) {
  const files = await readZip(backup);
  const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')) as Record<string, unknown>;
  files.delete('manifest.json');
  if (change.database) {
    const file = join(dir, `${randomUUID()}.sqlite`);
    writeFileSync(file, files.get('database.sqlite')!);
    const sqlite = new BetterSqlite3(file);
    change.database(sqlite);
    sqlite.close();
    files.set('database.sqlite', readFileSync(file));
  }
  change.files?.(files);
  if (!change.keepManifest) manifest.files = [...files].map(([path, data]) => ({ path, size: data.length, sha256: sha256(data) }));
  change.manifest?.(manifest);
  return writeZipBuffer([['manifest.json', Buffer.from(JSON.stringify(manifest))], ...files]);
}

describe('backups (BAK-1, BAK-2, BAK-9)', () => {
  it('downloads a ZIP of the manifest, the database without sessions, and config.yaml', async () => {
    const config = 'site:\n  supportUrl: https://example.com/help\n';
    const s = server(config);
    try {
      const cookie = await adminCookie(s.context);
      await setTitle(s, cookie, 'Before');
      const response = await s.app.inject({ url: '/api/admin/backup', headers: { cookie } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-type'], 'application/zip');
      assert.match(String(response.headers['content-disposition']), /^attachment; filename="agt-trivia-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.zip"$/);
      const files = await readZip(response.rawPayload);
      assert.deepEqual([...files.keys()], ['manifest.json', 'database.sqlite', 'config.yaml']);
      assert.equal(files.get('config.yaml')!.toString('utf8'), config);
      const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));
      assert.deepEqual(Object.keys(manifest).sort(), ['appVersion', 'createdAt', 'files', 'format', 'formatVersion', 'schemaVersion']);
      assert.equal(manifest.format, 'agt-trivia-backup');
      assert.equal(manifest.formatVersion, 1);
      assert.equal(manifest.appVersion, '0.0.0-test');
      for (const file of manifest.files) assert.equal(sha256(files.get(file.path)!), file.sha256);
      const dbFile = join(s.context.dataDir, 'check.sqlite');
      writeFileSync(dbFile, files.get('database.sqlite')!);
      const sqlite = new BetterSqlite3(dbFile, { readonly: true });
      assert.equal((sqlite.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n, 0);
      assert.equal((sqlite.prepare('SELECT count(*) AS n FROM admin').get() as { n: number }).n, 1);
      assert.equal(sqlite.pragma('journal_mode', { simple: true }), 'delete');
      sqlite.close();
      // The work directory is gone once the download is sent; the download is audited.
      assert.deepEqual(readdirSync(join(s.context.dataDir, 'backups')), []);
      assert.ok(s.context.logs.listAudit({}, null, 100).some((entry) => entry.action === 'downloadBackup' && entry.outcome === 'success'));
    } finally {
      await s.close();
    }
  });

  it('leaves config.yaml out when there is none, and needs the Admin', async () => {
    const s = server();
    try {
      assert.equal((await s.app.inject('/api/admin/backup')).statusCode, 401);
      const files = await readZip(await download(s, await adminCookie(s.context)));
      assert.deepEqual([...files.keys()], ['manifest.json', 'database.sqlite']);
    } finally {
      await s.close();
    }
  });
});

describe('restores (BAK-3, BAK-4, BAK-5)', () => {
  it('previews without changing anything, then restores, signs everyone out and keeps a pre-restore backup', async () => {
    const s = server('server:\n  port: 8082\n');
    try {
      const cookie = await adminCookie(s.context);
      await setTitle(s, cookie, 'Backed up');
      const backup = await download(s, cookie);
      await setTitle(s, cookie, 'Changed later');

      const preview = await upload(s, cookie, 'preview', backup);
      assert.equal(preview.statusCode, 200, preview.body);
      const report = preview.json();
      assert.equal(report.counts.admin, 1);
      assert.equal(report.counts.settings, 1);
      assert.equal(report.adminUsername, 'keeper');
      assert.deepEqual(report.warningCodes, []);
      assert.deepEqual(report.config, { included: true, identical: true, diff: [{ kind: ' ', text: 'server:' }, { kind: ' ', text: '  port: 8082' }, { kind: ' ', text: '' }], content: 'server:\n  port: 8082\n' });
      assert.equal(report.preRestoreBackup, null);
      assert.equal(storedTitle(s), 'Changed later');

      const restored = await upload(s, cookie, 'restore', backup);
      assert.equal(restored.statusCode, 200, restored.body);
      assert.match(String(restored.headers['set-cookie']), /^agt_trivia_session=;/);
      assert.equal(storedTitle(s), 'Backed up');
      assert.equal(s.context.operations.state, 'idle');
      // Every session is gone (BAK-4 step 6.1); the restored Admin signs in again.
      assert.equal((await s.app.inject({ url: '/api/admin/session', headers: { cookie } })).statusCode, 401);
      const preRestore = restored.json().preRestoreBackup as string;
      assert.match(preRestore, /^pre-restore-backup-.*\.zip$/);
      // Only the pre-restore backup is left in the backups directory; nothing set aside beside the database.
      assert.deepEqual(readdirSync(join(s.context.dataDir, 'backups')), [preRestore]);
      assert.deepEqual(readdirSync(s.context.dataDir).filter((name) => name.includes('.restore-')), []);
      // The pre-restore backup holds the replaced data and restores like any other.
      const newCookie = await adminCookie(s.context);
      const again = await upload(s, newCookie, 'restore', readFileSync(join(s.context.dataDir, 'backups', preRestore)));
      assert.equal(again.statusCode, 200, again.body);
      assert.equal(storedTitle(s), 'Changed later');
      // The restore is audited with counts, never content (LOG-14).
      const entry = s.context.logs.listAudit({}, null, 100).find((candidate) => candidate.action === 'restoreBackup' && candidate.outcome === 'success');
      assert.ok(entry);
      assert.doesNotMatch(JSON.stringify(entry), /Changed later|Backed up/);
    } finally {
      await s.close();
    }
  });

  it('never writes config.yaml, shows its diff, and drops settings the current config.yaml locks (BAK-5, CFG-8)', async () => {
    const source = server('server:\n  port: 8082\n');
    const target = server('site:\n  title: Locked title\n');
    try {
      const sourceCookie = await adminCookie(source.context);
      await setTitle(source, sourceCookie, 'From the backup');
      const backup = await download(source, sourceCookie);
      const cookie = await adminCookie(target.context);
      const report = (await upload(target, cookie, 'preview', backup)).json();
      assert.equal(report.config.identical, false);
      assert.deepEqual(report.config.diff.filter((line: { kind: string }) => line.kind !== ' '), [
        { kind: '-', text: 'site:' }, { kind: '-', text: '  title: Locked title' }, { kind: '+', text: 'server:' }, { kind: '+', text: '  port: 8082' },
      ]);
      assert.deepEqual(report.ignoredSettings, ['site.title']);
      const restored = await upload(target, cookie, 'restore', backup);
      assert.equal(restored.statusCode, 200, restored.body);
      assert.deepEqual(restored.json().ignoredSettings, ['site.title']);
      assert.equal(storedTitle(target), undefined);
      assert.equal(target.context.configFile.text, 'site:\n  title: Locked title\n');
      assert.equal(existsSync(join(target.context.dataDir, 'config.yaml')), false);
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('warns about a backup without an Admin', async () => {
    const s = server();
    try {
      const cookie = await adminCookie(s.context);
      const backup = await rebuild(await download(s, cookie), s.context.dataDir, { database: (sqlite) => sqlite.prepare('DELETE FROM admin').run() });
      const report = (await upload(s, cookie, 'preview', backup)).json();
      assert.deepEqual(report.warningCodes, ['no_admin']);
      assert.equal(report.counts.admin, 0);
    } finally {
      await s.close();
    }
  });

  it('checks the request: multipart, the action and the file', async () => {
    const s = server('backup:\n  maxZipBytes: 1048576\n');
    try {
      const cookie = await adminCookie(s.context);
      const json = await s.app.inject({ method: 'POST', url: '/api/admin/restore', headers: { cookie, ...csrf }, payload: { action: 'preview' } });
      assert.equal(json.statusCode, 415);
      assert.equal(json.json().error, 'multipart_required');
      assert.equal((await upload(s, cookie, 'preview', null)).json().error, 'file_required');
      const badAction = multipart('replace', Buffer.from('x'));
      const response = await s.app.inject({ method: 'POST', url: '/api/admin/restore', headers: { cookie, ...csrf, ...badAction.headers }, payload: badAction.payload });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().fields[0].field, 'action');
      const tooLarge = await upload(s, cookie, 'preview', Buffer.alloc(1048577));
      assert.equal(tooLarge.statusCode, 413);
      assert.deepEqual(tooLarge.json().params, { maxBytes: 1048576 });
      const noCsrf = multipart('preview', Buffer.from('x'));
      assert.equal((await s.app.inject({ method: 'POST', url: '/api/admin/restore', headers: { cookie, ...noCsrf.headers }, payload: noCsrf.payload })).statusCode, 403);
      // Every upload's work directory is deleted (SEC-10).
      assert.deepEqual(readdirSync(join(s.context.dataDir, 'backups')), []);
    } finally {
      await s.close();
    }
  });

  it('rejects archives that fail a check, changing nothing (BAK-3, BAK-7, SEC-10)', async () => {
    const s = server();
    try {
      const cookie = await adminCookie(s.context);
      await setTitle(s, cookie, 'Live');
      const backup = await download(s, cookie);
      const dir = s.context.dataDir;
      const tamper = (database: Buffer) => { const copy = Buffer.from(database); copy[copy.length - 1] ^= 0xff; return copy; };
      // Entry names of equal length, renamed in the raw bytes after yazl wrote them.
      const unsafe = (await writeZipBuffer([['xx/manifest.json', Buffer.from('{}')]]));
      const unsafeZip = Buffer.from(unsafe.toString('latin1').replaceAll('xx/manifest.json', '../manifest.js'.padEnd(16, 'n')), 'latin1');
      const cases: [string, Buffer][] = [
        ['not_zip', Buffer.from('not a zip file')],
        ['unsafe_zip', unsafeZip],
        ['missing_manifest', await writeZipBuffer([['database.sqlite', Buffer.from('x')]])],
        ['invalid_manifest', await rebuild(backup, dir, { manifest: (m) => { m.extra = true; } })],
        ['not_a_backup', await rebuild(backup, dir, { manifest: (m) => { m.format = 'agt-other-backup'; } })],
        ['newer_format', await rebuild(backup, dir, { manifest: (m) => { m.formatVersion = 2; } })],
        ['checksum_mismatch', await rebuild(backup, dir, { files: (f) => f.set('database.sqlite', tamper(f.get('database.sqlite')!)), keepManifest: true })],
        ['unlisted_file', await rebuild(backup, dir, { manifest: (m) => { m.files = (m.files as { path: string }[]).filter((file) => file.path !== 'database.sqlite'); } })],
        ['missing_file', await rebuild(backup, dir, { files: (f) => f.delete('database.sqlite'), manifest: (m) => { (m.files as unknown[]).push({ path: 'database.sqlite', size: 1, sha256: '0'.repeat(64) }); } })],
        ['invalid_database', await rebuild(backup, dir, { files: (f) => f.set('database.sqlite', Buffer.from('not a database')) })],
        ['disallowed_entry', await rebuild(backup, dir, { database: (db) => db.exec("CREATE TRIGGER t AFTER INSERT ON settings BEGIN SELECT 1; END") })],
        ['disallowed_entry', await rebuild(backup, dir, { database: (db) => db.exec('CREATE TABLE extra (id TEXT)') })],
        ['newer_schema', await rebuild(backup, dir, { database: (db) => db.pragma('user_version = 999'), manifest: (m) => { m.schemaVersion = 999; } })],
        ['schema_mismatch', await rebuild(backup, dir, { manifest: (m) => { m.schemaVersion = 1; } })],
        ['missing_tables', await rebuild(backup, dir, { database: (db) => db.exec('DROP TABLE sessions') })],
        ['invalid_admin', await rebuild(backup, dir, { database: (db) => db.prepare("UPDATE admin SET password_hash = 'plain'").run() })],
      ];
      for (const [reason, archive] of cases) {
        for (const action of ['preview', 'restore'] as const) {
          const response = await upload(s, cookie, action, archive);
          assert.equal(response.statusCode, 422, `${reason} ${action}: ${response.body}`);
          assert.equal(response.json().error, 'archive_rejected');
          assert.equal(response.json().params.reason, reason, `${reason} ${action}: ${response.body}`);
        }
      }
      assert.equal(storedTitle(s), 'Live');
      assert.equal((await s.app.inject({ url: '/api/admin/session', headers: { cookie } })).statusCode, 200);
      assert.deepEqual(readdirSync(join(dir, 'backups')), []);
      const rejected = s.context.logs.listAudit({}, null, 1000).filter((entry) => entry.action === 'restoreBackup' && entry.outcome !== 'success');
      assert.ok(rejected.length > 0);
    } finally {
      await s.close();
    }
  });

  it('applies the entry limits before extracting (SEC-10)', async () => {
    const s = server('backup:\n  maxEntries: 2\n');
    try {
      const cookie = await adminCookie(s.context);
      const response = await upload(s, cookie, 'preview', await download(s, cookie).then((backup) => rebuild(backup, s.context.dataDir, { files: (f) => f.set('config.yaml', Buffer.from('a: 1\n')) })));
      assert.equal(response.json().params.reason, 'unsafe_zip', response.body);
    } finally {
      await s.close();
    }
  });
});

describe('the operation lock (BAK-8, BAK-9)', () => {
  it('holds data writes while the backup snapshot is taken, then lets them through', async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let snapshotted!: () => void;
    const reached = new Promise<void>((resolve) => { snapshotted = resolve; });
    const s = server('', { hooks: { afterSnapshot: async () => { snapshotted(); await paused; } } });
    try {
      const cookie = await adminCookie(s.context);
      await setTitle(s, cookie, 'Before');
      const backup = s.app.inject({ url: '/api/admin/backup', headers: { cookie } });
      await reached;
      assert.equal(s.context.operations.state, 'backup');
      let written = false;
      const write = setTitle(s, cookie, 'During').then((response) => { written = true; return response; });
      // A second backup or a restore is refused while one runs.
      assert.equal((await s.app.inject({ url: '/api/admin/backup', headers: { cookie } })).json().error, 'conflict');
      // Reads still work.
      assert.equal((await s.app.inject({ url: '/api/admin/settings', headers: { cookie } })).statusCode, 200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(written, false);
      release();
      assert.equal((await write).statusCode, 200);
      const files = await readZip((await backup).rawPayload);
      const dbFile = join(s.context.dataDir, 'check.sqlite');
      writeFileSync(dbFile, files.get('database.sqlite')!);
      const sqlite = new BetterSqlite3(dbFile, { readonly: true });
      assert.equal(JSON.parse((sqlite.prepare("SELECT value FROM settings WHERE key = 'site.title'").get() as { value: string }).value), 'Before');
      sqlite.close();
      assert.equal(storedTitle(s), 'During');
    } finally {
      release();
      await s.close();
    }
  });

  it('answers a write 503 maintenance when the backup holds it too long', async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const s = server('', { timings: { writeWaitMs: 30 }, hooks: { afterSnapshot: () => paused } });
    try {
      const cookie = await adminCookie(s.context);
      const backup = s.app.inject({ url: '/api/admin/backup', headers: { cookie } });
      while (s.context.operations.state !== 'backup') await new Promise((resolve) => setTimeout(resolve, 5));
      const write = await setTitle(s, cookie, 'During');
      assert.equal(write.statusCode, 503);
      assert.equal(write.json().error, 'maintenance');
      assert.equal(write.headers['retry-after'], '10');
      release();
      assert.equal((await backup).statusCode, 200);
    } finally {
      release();
      await s.close();
    }
  });

  it('answers 409 when the server stays busy for the whole drain, changing nothing', async () => {
    const s = server('', { timings: { drainMs: 30 } });
    try {
      const cookie = await adminCookie(s.context);
      await setTitle(s, cookie, 'Live');
      const backup = await download(s, cookie);
      const job = s.context.operations.enterActivity();
      const response = await upload(s, cookie, 'restore', backup);
      job();
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error, 'conflict');
      assert.equal(s.context.operations.state, 'idle');
      assert.equal((await s.app.inject({ url: '/api/admin/session', headers: { cookie } })).statusCode, 200);
      // A write held past the drain makes the backup answer 409 too.
      const writeDone = await s.context.operations.enterWrite();
      assert.equal((await s.app.inject({ url: '/api/admin/backup', headers: { cookie } })).json().error, 'conflict');
      writeDone();
    } finally {
      await s.close();
    }
  });

  it('answers every request but the health check 503 during a restore', async () => {
    const s = server();
    try {
      const cookie = await adminCookie(s.context);
      await s.context.operations.begin('restore');
      for (const url of ['/api/settings/public', '/api/admin/session', '/api/setup/status']) {
        const response = await s.app.inject({ url, headers: { cookie } });
        assert.equal(response.statusCode, 503, url);
        assert.equal(response.json().error, 'maintenance');
        assert.deepEqual(response.json().params, { retryAfterSeconds: 10 });
        assert.equal(response.headers['retry-after'], '10');
      }
      const health = await s.app.inject('/api/health');
      assert.equal(health.statusCode, 200);
      assert.deepEqual(health.json(), { status: 'maintenance' });
      s.context.operations.end('idle');
      assert.deepEqual((await s.app.inject('/api/health')).json(), { status: 'ok' });
    } finally {
      await s.close();
    }
  });
});

describe('failed restores (BAK-10, BAK-11)', () => {
  async function failingRestore(hooks: BackupHooks) {
    const s = server('', { hooks });
    const cookie = await adminCookie(s.context);
    await setTitle(s, cookie, 'Backed up');
    const backup = await download(s, cookie);
    await setTitle(s, cookie, 'Live');
    const response = await upload(s, cookie, 'restore', backup);
    return { s, cookie, backup, response };
  }

  for (const [name, hooks] of [
    ['after the swap', { afterSwap: () => { throw new Error('injected'); } }],
    ['inside the step 6.1 transaction', { duringCommit: () => { throw new Error('injected'); } }],
  ] as [string, BackupHooks][]) {
    it(`rolls back a failure ${name}: data, settings and sessions as before`, async () => {
      const { s, cookie, response } = await failingRestore(hooks);
      try {
        assert.equal(response.statusCode, 500);
        assert.equal(response.json().message, 'The restore failed and was rolled back. Nothing was changed.');
        assert.equal(s.context.operations.state, 'idle');
        assert.equal(storedTitle(s), 'Live');
        assert.equal((await s.app.inject({ url: '/api/admin/session', headers: { cookie } })).statusCode, 200);
        assert.deepEqual(readdirSync(s.context.dataDir).filter((file) => file.includes('.restore-')), []);
        assert.equal(existsSync(markerFile(s.context.dataDir)), false);
      } finally {
        await s.close();
      }
    });
  }

  it('reports set-aside files it could not delete as a warning', async () => {
    const { s, response } = await failingRestore({ deleteSetAside: () => { throw new Error('busy'); } });
    try {
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().warningCodes, ['set_aside_not_deleted']);
      assert.equal(storedTitle(s), 'Backed up');
      assert.ok(readdirSync(s.context.dataDir).some((file) => file.includes('.restore-old-')));
    } finally {
      await s.close();
    }
  });

  it('stays in maintenance when the rollback fails, and lets only the recovery session restore', async () => {
    const hooks: BackupHooks = { afterSwap: () => { throw new Error('injected'); }, duringRollback: () => { throw new Error('rollback failed'); } };
    const { s, cookie, backup, response } = await failingRestore(hooks);
    try {
      assert.equal(response.statusCode, 500);
      assert.equal(response.json().message, 'The restore failed and could not be rolled back. The app stays in maintenance.');
      assert.equal(s.context.operations.state, 'restore_failed');
      const marker = JSON.parse(readFileSync(markerFile(s.context.dataDir), 'utf8'));
      assert.match(marker.preRestoreBackup, /^pre-restore-backup-.*\.zip$/);
      assert.ok(existsSync(join(s.context.dataDir, 'backups', marker.preRestoreBackup)));
      assert.deepEqual((await s.app.inject('/api/health')).json(), { status: 'maintenance' });
      // Without the recovery session, everything is in maintenance.
      assert.equal((await s.app.inject('/api/admin/session')).statusCode, 503);
      assert.equal((await s.app.inject({ url: '/api/admin/session', headers: { cookie: 'agt_trivia_session=other' } })).statusCode, 503);
      // The recovery session reads its session and restores, nothing else.
      const session = await s.app.inject({ url: '/api/admin/session', headers: { cookie } });
      assert.equal(session.statusCode, 200);
      assert.equal(session.json().restoreFailed, true);
      assert.equal((await s.app.inject({ url: '/api/admin/settings', headers: { cookie } })).statusCode, 503);
      assert.equal((await setTitle(s, cookie, 'x')).statusCode, 503);
      delete hooks.afterSwap;
      delete hooks.duringRollback;
      const recovery = await upload(s, cookie, 'restore', backup);
      assert.equal(recovery.statusCode, 200, recovery.body);
      assert.equal(recovery.json().preRestoreBackup, marker.preRestoreBackup);
      assert.equal(s.context.operations.state, 'idle');
      assert.equal(existsSync(markerFile(s.context.dataDir)), false);
      assert.equal(storedTitle(s), 'Backed up');
      assert.equal((await s.app.inject({ url: '/api/admin/session', headers: { cookie } })).statusCode, 401);
      assert.deepEqual((await s.app.inject('/api/health')).json(), { status: 'ok' });
    } finally {
      await s.close();
    }
  });
});

describe('ZIP and diff helpers (SEC-10, BAK-5)', () => {
  it('accepts only relative POSIX paths', () => {
    for (const path of ['manifest.json', 'a/b.txt']) assert.equal(isSafePath(path), true, path);
    for (const path of ['', '/etc/passwd', '../x', 'a/../b', './a', 'a\\b', 'C:/x', 'a//b', 'a/']) assert.equal(isSafePath(path), false, path);
  });

  it('refuses unlisted paths, too many entries and too many bytes before extracting', async () => {
    const context = testContext();
    const file = join(context.dataDir, 'test.zip');
    writeFileSync(file, await writeZipBuffer([['a.txt', Buffer.alloc(100)], ['b.txt', Buffer.alloc(100)]]));
    const generous = { maxEntries: 10, maxUncompressedBytes: 1000 };
    const zip = await openSafeZip(file, generous, new Set(['a.txt', 'b.txt']));
    assert.equal(zip.entries.length, 2);
    zip.close();
    const reason = async (limits: typeof generous, allowed: string[]) => {
      try {
        (await openSafeZip(file, limits, new Set(allowed))).close();
        return null;
      } catch (error) {
        return (error as { params?: { reason?: string } }).params?.reason;
      }
    };
    assert.equal(await reason(generous, ['a.txt']), 'unlisted_file');
    assert.equal(await reason({ ...generous, maxEntries: 1 }, ['a.txt', 'b.txt']), 'unsafe_zip');
    assert.equal(await reason({ ...generous, maxUncompressedBytes: 150 }, ['a.txt', 'b.txt']), 'too_large');
    context.close();
  });

  it('diffs config.yaml by lines', () => {
    assert.deepEqual(lineDiff('a\nb\nc', 'a\nc\nd'), [
      { kind: ' ', text: 'a' }, { kind: '-', text: 'b' }, { kind: ' ', text: 'c' }, { kind: '+', text: 'd' },
    ]);
    assert.deepEqual(lineDiff('', 'x'), [{ kind: '-', text: '' }, { kind: '+', text: 'x' }]);
  });
});
