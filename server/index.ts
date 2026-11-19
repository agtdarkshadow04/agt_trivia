import pino from 'pino';
import packageJson from '../package.json' with { type: 'json' };
import { buildApp } from './app.js';
import { ConfigError } from './config.js';
import { openDatabase, SchemaTooNewError, SCHEMA_VERSION, type OpenedDatabase } from './db.js';
import { setupPasswordCheck } from './session.js';
import { loadStartup, type Startup } from './startup.js';

/**
 * The entry point and the only file that reads `process.env` or calls
 * `listen()` (SRV-1). It loads `config.yaml`, opens and migrates the
 * database, builds the app and listens; on SIGTERM or SIGINT it closes both
 * (SRV-7). Any startup problem stops the server with one clear line (SRV-8).
 */

const version = packageJson.version;
let logger = pino({ level: 'info' });

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
logger = pino({ level: config.server.logLevel });
if (startup.configFile.text === null) {
  logger.warn({ source: 'config', path: startup.configFile.path }, `No configuration file at ${startup.configFile.path}; using the defaults.`);
}

let opened: OpenedDatabase;
try {
  opened = openDatabase(startup.databaseFile);
} catch (error) {
  if (error instanceof SchemaTooNewError) fail(error.message);
  fail(`The database ${startup.databaseFile} could not be opened: ${error instanceof Error ? error.message : String(error)}`, error);
}
for (const migration of opened.applied) {
  logger.info({ source: 'migrations', version: migration.version, name: migration.name }, `Applied migration ${migration.name}.`);
}

const context = {
  config,
  configFile: { path: startup.configFile.path, text: startup.configFile.text },
  db: opened.db,
  setupPassword: startup.setupPassword,
  version,
};
// AUTH-5, AUTH-6: a setup password too long to type stops the server; one left set after setup is a warning.
const setupCheck = setupPasswordCheck(context);
if (setupCheck.error) {
  opened.db.close();
  fail(setupCheck.error);
}
if (setupCheck.warning) logger.warn({ source: 'config' }, setupCheck.warning);

const app = buildApp(context, { logger, staticDir: startup.staticDir });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ source: 'shutdown', signal }, 'Shutting down.');
  await app.close();
  opened.db.close();
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
    address,
    configFile: startup.configFile.text === null ? null : startup.configFile.path,
  }, `AGT Galactic Trivia ${version} listening on ${address}.`);
} catch (error) {
  opened.db.close();
  fail(`The server could not listen on ${config.server.host}:${config.server.port}: ${error instanceof Error ? error.message : String(error)}`, error);
}
