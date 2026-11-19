import { readFileSync, statSync } from 'node:fs';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { parse as parseYaml } from 'yaml';
import { quizLengthLimits, quizLengthsError } from '../src/lib/validation.js';

/**
 * `config.yaml`: its TypeBox schema (CFG-3), the standard keys (CFG-5) and the
 * dashboard-editable settings (CFG-6). Only `server/startup.ts` decides where
 * the file lives; nothing here reads the environment (SRV-1). Later sub-issues
 * of #6 add their groups (`session`, `rateLimits`, `backup`, `logs`, `iam`).
 */

/** Where the server looks for its configuration file unless AGT_TRIVIA_CONFIG_FILE says otherwise. */
export const defaultConfigPath = './config.yaml';

/** The default listen port, from the spec's app registry (§2.1, #8). */
export const defaultPort = 8082;

const nonBlank = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: '\\S' });
const integer = (minimum: number, maximum: number) => Type.Integer({ minimum, maximum });

interface EditableSetting<T extends TSchema = TSchema> {
  schema: T;
  default: Static<T>;
  description: string;
}

const editable = <T extends TSchema>(schema: T, defaultValue: Static<T>, description: string): EditableSetting<T> => ({
  schema,
  default: defaultValue,
  description,
});

/**
 * Settings the Admin can change in the dashboard (CFG-6), by dotted key. Only
 * these keys are stored in the `settings` table, and each `schema` validates
 * both the dashboard value and the same key in `config.yaml`, which wins (CFG-7).
 */
export const EDITABLE_SETTINGS = {
  'site.title': editable(nonBlank(100), 'AGT Galactic Trivia', 'Name shown in the header and the browser title.'),
  'site.supportUrl': editable(
    Type.String({ maxLength: 2000, pattern: '^https?://[^\\s/?#]+[^\\s]*$' }),
    'https://www.nms-agt.com/support',
    'Support link: an absolute http: or https: URL.',
  ),
  'quiz.shortLength': editable(
    integer(quizLengthLimits.short.min, quizLengthLimits.short.max),
    10,
    'Number of questions in a short quiz (1-100, less than quiz.longLength).',
  ),
  'quiz.longLength': editable(
    integer(quizLengthLimits.long.min, quizLengthLimits.long.max),
    30,
    'Number of questions in a long quiz (2-500, more than quiz.shortLength).',
  ),
} satisfies Record<string, EditableSetting>;

export type SettingKey = keyof typeof EDITABLE_SETTINGS;
export type SettingValues = { -readonly [Key in SettingKey]: Static<typeof EDITABLE_SETTINGS[Key]['schema']> };
export const settingKeys = Object.keys(EDITABLE_SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(EDITABLE_SETTINGS, key);
}

/** Whether `value` is allowed for `key` on its own (CFG-6); cross-key rules are in `src/lib/validation.ts`. */
export function validSetting(key: SettingKey, value: unknown) {
  return Value.Check(EDITABLE_SETTINGS[key].schema, value);
}

const optional = <T extends TSchema>(schema: T) => Type.Optional(schema);
const group = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false, default: {} });
const fileSetting = <Key extends SettingKey>(key: Key) => optional(EDITABLE_SETTINGS[key].schema as typeof EDITABLE_SETTINGS[Key]['schema']);

/** `true`, or the proxy's address or CIDR range (one or a list), as Fastify's `trustProxy` takes them (SEC-4). */
const TrustProxy = Type.Union([
  Type.Boolean(),
  Type.String({ minLength: 1 }),
  Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
]);

/**
 * The configuration file schema. Every key is optional. Dashboard-editable
 * keys have no default here: `undefined` means "not set in the file", and
 * `settingStates()` falls back to the dashboard value or the default.
 */
export const ConfigSchema = Type.Object({
  server: group({
    host: optional(Type.String({ minLength: 1 })),
    port: Type.Integer({ minimum: 1, maximum: 65_535, default: defaultPort }),
    trustProxy: Type.Union(TrustProxy.anyOf, { default: false }),
    logLevel: Type.Union(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].map((level) => Type.Literal(level)), { default: 'info' }),
  }),
  storage: group({
    dataDir: Type.String({ minLength: 1, default: 'data' }),
    databaseFile: Type.String({ minLength: 1, default: 'agt-trivia.sqlite' }),
  }),
  site: group({
    title: fileSetting('site.title'),
    supportUrl: fileSetting('site.supportUrl'),
  }),
  quiz: group({
    shortLength: fileSetting('quiz.shortLength'),
    longLength: fileSetting('quiz.longLength'),
  }),
}, { additionalProperties: false });

type ParsedConfig = Static<typeof ConfigSchema>;

/** The validated configuration with every default applied; `server.host` is always resolved. */
export type AppConfig = ParsedConfig & {
  server: ParsedConfig['server'] & { host: string };
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Tree = Record<string, unknown>;

function isTree(value: unknown): value is Tree {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getPath(tree: Tree, key: string): unknown {
  let node: unknown = tree;
  for (const part of key.split('.')) {
    if (!isTree(node)) return undefined;
    node = node[part];
  }
  return node;
}

/** The value `config.yaml` sets for a key, or undefined. */
export function configValue(config: AppConfig, key: string): unknown {
  return getPath(config as unknown as Tree, key);
}

/**
 * Treats `key:` with no value (YAML null), as left by a section whose keys are
 * all commented out, the same as an absent key.
 */
function withoutNulls(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value) || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Tree)
    .map(([key, entry]) => [key, withoutNulls(entry)] as const)
    .filter(([, entry]) => entry !== undefined));
}

function describeErrors(value: unknown) {
  const messages = new Map<string, string>();
  for (const error of Value.Errors(ConfigSchema, value)) {
    const path = error.path.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~')).join('.') || '(root)';
    // A union reports each branch; the first message for a key is enough.
    if (!messages.has(path)) messages.set(path, error.message);
  }
  return [...messages].map(([path, message]) => `${path}: ${message}`).join('; ');
}

export interface ConfigOptions {
  /** Names the file in error messages. */
  source?: string;
  /** `server.host` when the file does not set it (AGT_TRIVIA_SERVER_HOST, CFG-2). */
  defaultHost?: string;
}

/**
 * Validates configuration file text (CFG-3). An empty file means "all
 * defaults". Unknown keys and invalid values throw a `ConfigError` naming the
 * key, e.g. `Invalid config.yaml: server.prot: Unexpected property`.
 */
export function parseConfig(text: string, options: ConfigOptions = {}): AppConfig {
  const source = options.source ?? 'configuration file';
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`${source} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const tree = withoutNulls(raw) ?? {};
  if (!isTree(tree)) throw new ConfigError(`Invalid ${source}: (root): Expected object`);

  // Defaults fill only absent keys; every value the file sets is then checked.
  const withDefaults = Value.Default(ConfigSchema, structuredClone(tree));
  if (!Value.Check(ConfigSchema, withDefaults)) throw new ConfigError(`Invalid ${source}: ${describeErrors(withDefaults)}`);
  const parsed = withDefaults as ParsedConfig;
  const { shortLength, longLength } = parsed.quiz;
  if (shortLength !== undefined && longLength !== undefined) {
    const problem = quizLengthsError(shortLength, longLength);
    if (problem) throw new ConfigError(`Invalid ${source}: ${problem.field}: ${problem.message}`);
  }
  return { ...parsed, server: { ...parsed.server, host: parsed.server.host ?? options.defaultHost ?? '127.0.0.1' } };
}

export interface LoadedConfig {
  config: AppConfig;
  path: string;
  /** The raw file text, or null when no file exists (all defaults, CFG-3). */
  text: string | null;
}

/** Reads and validates the configuration file; a missing file means all defaults. The app never writes it (CFG-3). */
export function loadConfigFile(path: string, options: Omit<ConfigOptions, 'source'> = {}): LoadedConfig {
  let text: string;
  try {
    if (statSync(path).isDirectory()) {
      throw new ConfigError(`${path} is a directory. Create the configuration file, for example with: cp config.example.yaml config.yaml`);
    }
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, text: null, config: parseConfig('', options) };
    throw error;
  }
  return { path, text, config: parseConfig(text, { ...options, source: path }) };
}
