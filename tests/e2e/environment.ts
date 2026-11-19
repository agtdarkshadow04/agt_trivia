import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The browser tests' server (TEST-6): a fresh data directory and a test
 * `config.yaml` for every run, so each run starts from first run.
 */
export const port = 8082;
export const baseURL = `http://127.0.0.1:${port}`;

/** Creates the run's data directory and config file; returns the server's environment. */
export function prepare(env: NodeJS.ProcessEnv): Record<string, string> {
  const directory = mkdtempSync(join(tmpdir(), 'agt-trivia-e2e-'));
  const configFile = join(directory, 'config.yaml');
  writeFileSync(configFile, [
    'server:',
    '  host: 127.0.0.1',
    `  port: ${port}`,
    '  logLevel: warn',
    'storage:',
    `  dataDir: ${JSON.stringify(join(directory, 'data'))}`,
    '',
  ].join('\n'));
  return {
    PATH: env.PATH ?? '',
    NODE_ENV: 'production',
    AGT_TRIVIA_CONFIG_FILE: configFile,
    AGT_TRIVIA_STATIC_DIR: 'dist',
  };
}
