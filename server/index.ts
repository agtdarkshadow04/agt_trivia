import pino from 'pino';
import packageJson from '../package.json' with { type: 'json' };
import { buildApp } from './app.js';
import { ConfigError } from './config.js';
import { settingValues } from './context.js';
import { openDatabase, SchemaTooNewError, SCHEMA_VERSION, type OpenedDatabase } from './db.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { markerFile } from './backup.js';
import { iamMissingName, iamStatus } from './iam.js';
import { createLogger, LOG_MIGRATIONS, logStoreStream, openLogStore, startRetention } from './logs.js';
import { OperationLock } from './operation.js';
import { readSettings } from './repository/settings.js';
import { setupPasswordCheck } from './session.js';
import { loadStartup, type Startup } from './startup.js';

/**
 * The entry point and the only file that reads `process.env` or calls
 * `listen()` (SRV-1). It loads `config.yaml`, opens the log store and the
 * database, builds the app and listens; on SIGTERM or SIGINT it closes them
 * (SRV-7). Any startup problem stops the server with one clear line (SRV-8).
 */

const version = packageJson.version;
/** Until the log store is open, startup problems go to stdout only. */
let logger: pino.Logger = pino({ level: 'info' });

function fail(message: string, error?: unknown): never {
  logger.fatal({ source: 'startup', ...(error ? { err: error } : {}) }, message);
  process.exit(1);
}

let startup: Startup;
try {
  startup = loadStartup(process.env);
} catch (error) {
  if (error instanceof ConfigError) fail(error.message);
  fail(`The configuration could not be read: ${error instanceof Error ? error.message : String(error)}`, error);
}
const { config } = startup.configFile;
const dataDir = resolve(config.storage.dataDir);

// BAK-11: after a failed restore whose rollback failed too, the data must not be served until the operator restores it.
const marker = markerFile(dataDir);
if (existsSync(marker)) {
  let preRestore: unknown = null;
  try { preRestore = (JSON.parse(readFileSync(marker, 'utf8')) as { preRestoreBackup?: unknown }).preRestoreBackup; } catch { /* named as unknown below */ }
  fail(`A restore failed and could not be rolled back, so the server refuses to start (${marker}). The data before the restore is in ${typeof preRestore === 'string' ? preRestore : 'an unknown file'} in the backups directory. Restore it by hand as README, Troubleshooting, "A restore failed" explains, then delete the marker file.`);
}

// LOG-1, LOG-3: the log store; a failure to write it is reported once, to stdout only.
const reportFailure = (message: string) => { process.stdout.write(`${JSON.stringify({ level: 40, time: Date.now(), source: 'logs', msg: message })}\n`); };
let logStore: ReturnType<typeof openLogStore>;
try {
  logStore = openLogStore(startup.logDatabaseFile, { report: reportFailure });
} catch (error) {
  if (error instanceof SchemaTooNewError) fail(`The log store ${startup.logDatabaseFile}: ${error.message}`);
  fail(`The log store ${startup.logDatabaseFile} could not be opened: ${error instanceof Error ? error.message : String(error)}`, error);
}
const logs = logStore.store;
// LOG-5: stdout and the server log from here on.
logger = createLogger(config, process.stdout, logStoreStream(logs, reportFailure));
for (const migration of logStore.applied) {
  logger.info({ source: 'migrations', store: 'logs', version: migration.version, name: migration.name }, `Applied log store migration ${migration.name}.`);
}
if (startup.configFile.text === null) {
  logger.warn({ source: 'config', path: startup.configFile.path }, `No configuration file at ${startup.configFile.path}; using the defaults.`);
}

let opened: OpenedDatabase;
try {
  opened = openDatabase(startup.databaseFile);
} catch (error) {
  logs.close();
  if (error instanceof SchemaTooNewError) fail(error.message);
  fail(`The database ${startup.databaseFile} could not be opened: ${error instanceof Error ? error.message : String(error)}`, error);
}
for (const migration of opened.applied) {
  logger.info({ source: 'migrations', version: migration.version, name: migration.name }, `Applied migration ${migration.name}.`);
}

const operations = new OperationLock();
const context = {
  config,
  configFile: { path: startup.configFile.path, text: startup.configFile.text },
  db: opened.db,
  dataDir,
  logs,
  operations,
  setupPassword: startup.setupPassword,
  iamApiKey: startup.iamApiKey,
  version,
};
// AUTH-5, AUTH-6: a setup password too long to type stops the server; one left set after setup is a warning.
const setupCheck = setupPasswordCheck(context);
if (setupCheck.error) {
  opened.db.close();
  fail(setupCheck.error);
}
if (setupCheck.warning) logger.warn({ source: 'config' }, setupCheck.warning);
// #18: AGT sign-in switched on but not fully configured is a warning; members then cannot use it.
const iam = iamStatus(context, settingValues(config, readSettings(context.db)));
if (iam.enabled && !iam.available) {
  logger.warn({ source: 'config' }, `AGT sign-in (iam.enabled) is on, but ${iam.missing.map(iamMissingName).join(', ')} ${iam.missing.length === 1 ? 'is' : 'are'} not set; members cannot sign in with their AGT account.`);
}

const app = buildApp(context, { logger, staticDir: startup.staticDir });

// LOG-15: retention now and every hour, with the effective logs.* settings.
// BAK-8: retention is a job; it pauses during a restore and counts as activity while it runs.
const retention = startRetention(logs, () => {
  const values = settingValues(config, readSettings(context.db));
  return {
    serverRetentionDays: values['logs.serverRetentionDays'],
    serverMaxEntries: values['logs.serverMaxEntries'],
    auditRetentionDays: values['logs.auditRetentionDays'],
    auditMaxEntries: values['logs.auditMaxEntries'],
  };
}, logger, () => (operations.inMaintenance ? null : operations.enterActivity()));

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ source: 'shutdown', signal }, 'Shutting down.');
  retention.stop();
  await app.close();
  opened.db.close();
  logs.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  const address = await app.listen({ host: config.server.host, port: config.server.port });
  // LOG-8: the startup entry, with the versions, the address and the configuration file.
  logger.info({
    source: 'startup',
    version,
    schemaVersion: opened.schemaVersion,
    supportedSchemaVersion: SCHEMA_VERSION,
    logSchemaVersion: LOG_MIGRATIONS.length,
    address,
    configFile: startup.configFile.text === null ? null : startup.configFile.path,
  }, `AGT Galactic Trivia ${version} listening on ${address}.`);
} catch (error) {
  opened.db.close();
  fail(`The server could not listen on ${config.server.host}:${config.server.port}: ${error instanceof Error ? error.message : String(error)}`, error);
}
