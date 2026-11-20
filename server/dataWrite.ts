import { AsyncLocalStorage } from 'node:async_hooks';
import type { OperationLock } from './operation.js';

/**
 * The data-write barrier (BAK-8). Every route that changes the main database
 * declares `writesData` (`server/routes.ts`), and `server/app.ts` runs its
 * handler inside `withDataWrite()`, which counts it on the operation lock:
 * during a backup it waits, during a restore it gets `503 maintenance`. Every
 * repository function that writes the main database calls `assertDataWrite()`
 * first, so a write anywhere else throws, in tests and in production. A backup
 * or restore marks its own writes with `asOperation()`.
 */

const writing = new AsyncLocalStorage<true>();

/** Runs `work` as a data write, counted on `lock` from start to end, errors included. */
export async function withDataWrite<T>(lock: Pick<OperationLock, 'enterWrite'>, work: () => T | Promise<T>): Promise<T> {
  const end = await lock.enterWrite();
  try {
    return await writing.run(true, work);
  } finally {
    end();
  }
}

/**
 * The writes of a backup or restore itself, which already holds the operation
 * lock (BAK-4 step 6.1), and of startup before the server listens (the
 * generated secrets, SEC-8).
 */
export function asOperation<T>(work: () => T): T {
  return writing.run(true, work);
}

export class DataWriteError extends Error {
  constructor() {
    super('A repository write ran outside withDataWrite(). Declare the route with writesData: true (BAK-8).');
    this.name = 'DataWriteError';
  }
}

/** Throws unless called inside `withDataWrite()` or `asOperation()`. */
export function assertDataWrite() {
  if (!writing.getStore()) throw new DataWriteError();
}
