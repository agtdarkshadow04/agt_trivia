import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The data-write barrier (BAK-8). Every route that changes the main database
 * declares `writesData` (`server/routes.ts`), and `server/app.ts` runs its
 * handler inside `withDataWrite()`. Every repository function that writes the
 * main database calls `assertDataWrite()` first, so a write anywhere else
 * throws, in tests and in production. The backup and restore operation lock
 * that writes wait for arrives with backups (#13); until then the barrier only
 * marks where writes may happen.
 */

const writing = new AsyncLocalStorage<true>();

/** Runs `work` as a data write. */
export function withDataWrite<T>(work: () => T): T {
  return writing.run(true, work);
}

export class DataWriteError extends Error {
  constructor() {
    super('A repository write ran outside withDataWrite(). Declare the route with writesData: true (BAK-8).');
    this.name = 'DataWriteError';
  }
}

/** Throws unless called inside `withDataWrite()`. */
export function assertDataWrite() {
  if (!writing.getStore()) throw new DataWriteError();
}
