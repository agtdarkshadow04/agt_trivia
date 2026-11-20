import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The browser tests' server (TEST-6): a fresh data directory and a test
 * `config.yaml` for every run, so each run starts from first run.
 */
export const port = 8082;
export const baseURL = `http://127.0.0.1:${port}`;
/** AGT_TRIVIA_SETUP_PASSWORD of the test server (AUTH-5). */
export const setupPassword = 'e2e-setup-password-1';
/** The fake AGT IAM (`fake-iam.ts`, #18) and the API key the app sends it. */
export const iamPort = 4182;
export const iamApiKey = 'e2e-iam-api-key';
/** A setting config.yaml locks, so the Settings tab shows it read-only (CFG-9). */
export const lockedSupportUrl = 'https://support.example.org/trivia';

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
    'site:',
    `  supportUrl: ${lockedSupportUrl}`,
    // AGT sign-in against the fake IAM; iam.enabled stays a dashboard setting, off until iam.spec.ts turns it on.
    'iam:',
    `  baseUrl: http://127.0.0.1:${iamPort}`,
    '  appId: agt-trivia-e2e',
    '  roleMap: { Editor: Editor, Moderator: Moderator }',
    // The suite signs in more often than a person would.
    'rateLimits:',
    '  login: { max: 1000, windowMinutes: 15 }',
    '  setup: { max: 1000, windowMinutes: 15 }',
    '',
  ].join('\n'));
  return {
    PATH: env.PATH ?? '',
    NODE_ENV: 'production',
    AGT_TRIVIA_CONFIG_FILE: configFile,
    AGT_TRIVIA_STATIC_DIR: 'dist',
    AGT_TRIVIA_SETUP_PASSWORD: setupPassword,
    AGT_TRIVIA_IAM_API_KEY: iamApiKey,
  };
}

/** The test server's database file, from the environment `playwright.config.ts` passes to every worker. */
export function databaseFile() {
  const serverEnv = JSON.parse(process.env.AGT_TRIVIA_E2E_SERVER_ENV ?? 'null') as Record<string, string> | null;
  if (!serverEnv) throw new Error('The browser tests run through playwright.config.ts, which prepares the server.');
  return join(serverEnv.AGT_TRIVIA_CONFIG_FILE, '..', 'data', 'agt-trivia.sqlite');
}

interface SeedQuestion {
  prompt: string;
  choices: [string, boolean][];
  status?: string;
  credit?: string;
}

/**
 * The quiz the player tests play (#16): Space (12 questions), Biology (2
 * single-answer and 1 multi-answer question, all with a credit but the
 * first) and Empty (only a draft). Correct answers start with "Right" or
 * "Also right", so the tests can find them. The app has no authoring or
 * import yet (#19, #22), so this writes the running server's database
 * directly, with the same columns the repository writes.
 */
export async function seedQuizData() {
  const { default: Database } = await import('better-sqlite3');
  const sqlite = new Database(databaseFile());
  sqlite.pragma('busy_timeout = 5000');
  const at = new Date().toISOString();
  const category = (shortName: string, name: string, description: string, priority: number) => {
    const id = randomUUID();
    sqlite.prepare(`INSERT INTO categories (id, short_name, name, description, priority, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(id, shortName, name, description, priority, at, at);
    return id;
  };
  const question = (categoryId: string, entry: SeedQuestion) => {
    const id = randomUUID();
    const status = entry.status ?? 'approved';
    sqlite.prepare(`INSERT INTO questions (id, category_id, prompt, status, author_credit, created_by, review_note, approved_by,
      approved_at, version, created_at, updated_at, modified_by) VALUES (?, ?, ?, ?, ?, NULL, '', NULL, ?, 1, ?, ?, NULL)`)
      .run(id, categoryId, entry.prompt, status, entry.credit ?? null, status === 'approved' ? at : null, at, at);
    entry.choices.forEach(([text, correct], position) => sqlite.prepare(`INSERT INTO question_choices
      (id, question_id, position, text, is_correct, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), id, position, text, correct ? 1 : 0, at, at));
  };
  sqlite.transaction(() => {
    const space = category('space', 'Space', 'Planets, stars and the void between them.', 10);
    for (let index = 1; index <= 12; index += 1) {
      question(space, { prompt: `Space question ${index}?`, choices: [[`Wrong ${index}`, false], [`Right ${index}`, true], [`Wrong again ${index}`, false]] });
    }
    const biology = category('bio', 'Biology', 'Life across the galaxy.', 20);
    question(biology, { prompt: 'Which one lives in water?', choices: [['Right fish', true], ['Wrong bird', false]] });
    question(biology, { prompt: 'Which one has leaves?', choices: [['Wrong rock', false], ['Right tree', true], ['Wrong cloud', false]], credit: 'Traveller Ada' });
    question(biology, { prompt: 'Which ones are mammals?', choices: [['Right whale', true], ['Wrong shark', false], ['Also right bat', true], ['Wrong frog', false]], credit: 'Traveller Ada' });
    const empty = category('empty', 'Empty', 'Nothing approved yet.', 30);
    question(empty, { prompt: 'Not approved?', choices: [['Right', true], ['Wrong', false]], status: 'draft' });
  })();
  sqlite.close();
}
