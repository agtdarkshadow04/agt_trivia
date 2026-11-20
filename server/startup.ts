import { resolve } from 'node:path';
import { defaultConfigPath, loadConfigFile, type LoadedConfig } from './config.js';

/**
 * Turns the process environment into what the entry point needs (CFG-1,
 * CFG-2). `server/index.ts` passes `process.env`; nothing else reads it
 * (SRV-1). Every variable is in the CFG-2 set: the secrets
 * `AGT_TRIVIA_SETUP_PASSWORD` and `AGT_TRIVIA_IAM_API_KEY`, and
 * `AGT_TRIVIA_CONFIG_FILE`, `AGT_TRIVIA_SERVER_HOST`, `AGT_TRIVIA_STATIC_DIR`.
 */

export type Env = Readonly<Record<string, string | undefined>>;

/** The prefix of every variable the app reads (NAME-2, CFG-2). */
export const envPrefix = 'AGT_TRIVIA_';

export interface Startup {
  configFile: LoadedConfig;
  /** The SQLite database file: `storage.databaseFile` inside `storage.dataDir` (DATA-5, DATA-10). */
  databaseFile: string;
  /** The log store: `storage.logDatabaseFile` inside `storage.dataDir` (LOG-1). */
  logDatabaseFile: string;
  /** The built client, `dist/` unless AGT_TRIVIA_STATIC_DIR says otherwise (development only). */
  staticDir: string;
  /** AGT_TRIVIA_SETUP_PASSWORD, or null when unset or empty (AUTH-5). */
  setupPassword: string | null;
  /** AGT_TRIVIA_IAM_API_KEY, the app's key for AGT IAM (#18), or null. Never logged, stored or returned. */
  iamApiKey: string | null;
}

/** Reads `AGT_TRIVIA_<name>`; empty values count as unset. */
export function envValue(env: Env, name: string): string | undefined {
  return env[`${envPrefix}${name}`] || undefined;
}

/** Loads config.yaml and the environment for the entry point. Throws with one clear message (SRV-8). */
export function loadStartup(env: Env): Startup {
  const configFile = loadConfigFile(envValue(env, 'CONFIG_FILE') ?? defaultConfigPath, { defaultHost: envValue(env, 'SERVER_HOST') });
  const { storage } = configFile.config;
  return {
    configFile,
    databaseFile: resolve(storage.dataDir, storage.databaseFile),
    logDatabaseFile: resolve(storage.dataDir, storage.logDatabaseFile),
    staticDir: resolve(envValue(env, 'STATIC_DIR') ?? 'dist'),
    setupPassword: envValue(env, 'SETUP_PASSWORD') ?? null,
    iamApiKey: envValue(env, 'IAM_API_KEY') ?? null,
  };
}
