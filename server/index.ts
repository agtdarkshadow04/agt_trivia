import { resolve } from 'node:path';
import pino from 'pino';
import packageJson from '../package.json' with { type: 'json' };
import { buildApp } from './app.js';

/**
 * The entry point and the only file that reads `process.env` or calls
 * `listen()` (SRV-1). `config.yaml`, the database and the log store arrive in
 * #10 and #12; until then the server listens on the registry port (#8).
 */
const host = process.env.AGT_TRIVIA_SERVER_HOST || '127.0.0.1';
const port = 8082;
const staticDir = resolve(process.env.AGT_TRIVIA_STATIC_DIR || 'dist');

const logger = pino({ level: 'info' });
const app = buildApp({ version: packageJson.version }, { logger, staticDir });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ source: 'shutdown', signal }, 'Shutting down.');
  await app.close();
  process.exit(0);
}
// SRV-7.
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  const address = await app.listen({ host, port });
  logger.info({ source: 'startup', version: packageJson.version, address }, `AGT Galactic Trivia ${packageJson.version} listening on ${address}.`);
} catch (error) {
  logger.fatal({ source: 'startup', err: error }, 'The server could not start.');
  process.exit(1);
}
