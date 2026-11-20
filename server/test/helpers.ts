import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { withDataWrite } from '../dataWrite.js';
import { ensureAttemptKey } from '../attempts.js';
import { Database, openDatabase, openSqlite, runMigrations } from '../db.js';
import { openLogStore } from '../logs.js';
import { insertCategory, type Category } from '../repository/categories.js';
import { insertQuestion, type NewQuestion, type Question } from '../repository/questions.js';
import { OperationLock, type OperationTimings } from '../operation.js';
import { adminSessionCookie, AdminAuthService, memberSessionCookie } from '../session.js';
import { AdminMemberService, MemberAuthService } from '../members.js';
import type { AdminMember, MemberRole } from '../../src/lib/api.js';

export interface TestContextOptions {
  setupPassword?: string | null;
  now?: () => Date;
  /** The operation lock's timings; tests of the 30-second drain use short ones (BAK-8). */
  timings?: Partial<OperationTimings>;
  /** A database file in the data directory instead of `:memory:`, for backups and restores (BAK-4). */
  file?: boolean;
  /** AGT_TRIVIA_IAM_API_KEY (#18). */
  iamApiKey?: string | null;
}

export type TestContext = AppContext & { close(): void };

/**
 * A context on a fresh, migrated database (TEST-3), in-memory unless `file` is
 * set, with its own temporary data directory. `config` is `config.yaml` text;
 * call `close()` in `after()`.
 */
export function testContext(config = '', options: TestContextOptions = {}): TestContext {
  const dataDir = mkdtempSync(join(tmpdir(), 'agt-trivia-test-'));
  let db: Database;
  if (options.file) {
    db = openDatabase(join(dataDir, 'agt-trivia.sqlite')).db;
  } else {
    const sqlite = openSqlite(':memory:');
    runMigrations(sqlite);
    db = new Database(sqlite);
  }
  // As server/index.ts does before listening (SEC-8, #45).
  ensureAttemptKey(db);
  const { store: logs } = openLogStore(':memory:', { now: options.now });
  return {
    config: parseConfig(config),
    configFile: { path: 'config.yaml', text: config || null },
    db,
    dataDir,
    logs,
    operations: new OperationLock({ drainMs: 30_000, writeWaitMs: 30_000, pollMs: 5, ...options.timings }),
    setupPassword: options.setupPassword === undefined ? testSetupPassword : options.setupPassword,
    iamApiKey: options.iamApiKey ?? null,
    version: '0.0.0-test',
    close: () => {
      db.close();
      logs.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** The setup password test contexts get unless they pass another (or null). */
export const testSetupPassword = 'setup-password-for-tests';

/** The Admin the sign-in helpers create. */
export const testAdmin = { username: 'keeper', password: 'Admin-Password-1!' };

const silentLog = { error: () => undefined, info: () => undefined };

/** Creates the Admin (unless it exists) and returns a `cookie` header value with a new session. */
export async function adminCookie(context: AppContext) {
  const auth = new AdminAuthService(context);
  const session = auth.adminExists()
    ? await auth.login(testAdmin.username, testAdmin.password, silentLog)
    : await withDataWrite(context.operations, () => auth.setup({ setupPassword: context.setupPassword ?? '', ...testAdmin }, silentLog));
  return `${adminSessionCookie}=${session.token}`;
}

/** The headers of a signed-in Admin write: the session cookie and the CSRF header. */
export async function adminWriteHeaders(context: AppContext) {
  return { cookie: await adminCookie(context), 'x-agt-request': '1' };
}

/** The SQLite change counter: how many rows inserts, updates and deletes touched so far. */
export function totalChanges(context: AppContext) {
  return (context.db.connection.prepare('SELECT total_changes() AS changes').get() as { changes: number }).changes;
}

/** A question for `seedQuiz()`: two choices, the first correct, approved unless `status` says otherwise. */
export function sampleQuestion(categoryId: string, prompt: string, overrides: Partial<NewQuestion> = {}): NewQuestion {
  return {
    categoryId,
    prompt,
    status: 'approved',
    authorCredit: null,
    createdBy: null,
    reviewNote: '',
    choices: [{ text: `${prompt} (right)`, isCorrect: true }, { text: `${prompt} (wrong)`, isCorrect: false }],
    ...overrides,
  };
}

/**
 * A category with `approved` approved questions, plus one of every other
 * status and one with a review note and a member ID, written as a data write.
 */
export async function seedQuiz(context: AppContext, approved = 3, category: Partial<Parameters<typeof insertCategory>[1]> = {}) {
  return withDataWrite(context.operations, () => {
    const created: Category = insertCategory(context.db, {
      shortName: 'space', name: 'Space', description: 'Questions about space.', priority: 10, ...category,
    });
    const questions: Question[] = [];
    for (let index = 0; index < approved; index += 1) questions.push(insertQuestion(context.db, sampleQuestion(created.id, `Approved ${index + 1}`)));
    const hidden = (['draft', 'pending', 'rejected'] as const).map((status) => insertQuestion(context.db, sampleQuestion(created.id, `Hidden ${status}`, {
      status, reviewNote: `secret note ${status}`, createdBy: '11111111-1111-4111-8111-111111111111',
    })));
    return { category: created, questions, hidden };
  });
}

/** The password of the members `createMember()` makes. */
export const testMemberPassword = 'Member-Password-1!';

/** Creates a local member as the Admin would (a data write). */
export async function createMember(context: AppContext, username: string, role: MemberRole = 'Player'): Promise<AdminMember> {
  const service = new AdminMemberService(context);
  return withDataWrite(context.operations, () => service.create({ username, displayName: `Display ${username}`, role, password: testMemberPassword }));
}

/** Signs a member in and returns a `cookie` header value with the member session. */
export async function memberCookie(context: AppContext, username: string) {
  const session = await new MemberAuthService(context).login(username, testMemberPassword, silentLog);
  return `${memberSessionCookie}=${session.token}`;
}
