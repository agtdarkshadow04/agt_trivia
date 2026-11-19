import { HttpError, MaintenanceError } from './http.js';

/**
 * The operation lock of a SQLite app (BAK-8): one per process, which is the
 * whole lock. Backups and restores start only from `idle`; entering a state
 * drains what it stops, for up to 30 seconds:
 * - `backup` waits for the data writes in progress and holds new ones;
 * - `restore` waits for every `/api/` request (except the health check) and
 *   job in progress, and refuses new ones with `503 maintenance`.
 * `restore_failed` (BAK-11) answers like `restore`, except for the recovery
 * session.
 */

export type OperationState = 'idle' | 'backup' | 'restore' | 'restore_failed';

/** BAK-11: the restoring Admin's session, kept in memory while a restore runs or has failed. */
export interface RecoverySession {
  tokenHash: string;
  username: string;
  expiresAt: Date;
}

export interface OperationTimings {
  /** How long entering a state waits for the work it stops (BAK-8: 30 seconds). */
  drainMs: number;
  /** How long a data write waits for a backup to finish before `503 maintenance` (30 seconds). */
  writeWaitMs: number;
  /** How often waiting code looks again. */
  pollMs: number;
}

export const defaultTimings: OperationTimings = { drainMs: 30_000, writeWaitMs: 30_000, pollMs: 20 };

export function busy() {
  return new HttpError(409, 'conflict', 'The server is busy. Try again.');
}

export function alreadyRunning() {
  return new HttpError(409, 'conflict', 'A backup or restore is already running.');
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Calls `release` once, however often it is called. */
function once(release: () => void) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

export class OperationLock {
  private current: OperationState = 'idle';
  private writes = 0;
  private activity = 0;
  /** The BAK-11 recovery session while a restore runs or has failed. */
  recovery: RecoverySession | null = null;

  constructor(private readonly timings: OperationTimings = defaultTimings) {}

  get state(): OperationState {
    return this.current;
  }

  /** Whether requests other than the health check are refused (BAK-8, BAK-11). */
  get inMaintenance() {
    return this.current === 'restore' || this.current === 'restore_failed';
  }

  private async until(condition: () => boolean, ms: number) {
    const deadline = Date.now() + ms;
    while (!condition()) {
      if (Date.now() >= deadline) return false;
      await wait(this.timings.pollMs);
    }
    return true;
  }

  /**
   * A data write starts (BAK-8). During a backup it waits until the lock is
   * `idle` again, for up to 30 seconds; during a restore, or after waiting too
   * long, it gets `503 maintenance`. Returns the function that ends it.
   */
  async enterWrite(): Promise<() => void> {
    if (this.current === 'backup') {
      const free = await this.until(() => this.current !== 'backup', this.timings.writeWaitMs);
      if (!free) throw new MaintenanceError();
    }
    if (this.current !== 'idle') throw new MaintenanceError();
    this.writes += 1;
    return once(() => { this.writes -= 1; });
  }

  /** An `/api/` request (except the health check) or a job starts; returns the function that ends it. */
  enterActivity(): () => void {
    this.activity += 1;
    return once(() => { this.activity -= 1; });
  }

  /**
   * Starts a backup or restore (BAK-8). Only from `idle`, or, for the recovery
   * restore of BAK-11, from `restore_failed`; otherwise `409 conflict`. Then
   * drains: a backup the writes in progress, a restore every request and job
   * except `ownActivity` (the restore request itself). A drain that does not
   * finish in 30 seconds puts the state back and answers `409 conflict`.
   */
  async begin(kind: 'backup' | 'restore', options: { recovery?: boolean; ownActivity?: number } = {}) {
    const from: OperationState = options.recovery ? 'restore_failed' : 'idle';
    if (this.current !== from) throw alreadyRunning();
    this.current = kind;
    const own = options.ownActivity ?? 0;
    const drained = await this.until(
      () => this.writes === 0 && (kind === 'backup' || this.activity <= own),
      this.timings.drainMs,
    );
    if (!drained) {
      this.current = from;
      throw busy();
    }
  }

  /** Ends the operation: `idle` after success or a rollback, `restore_failed` when even the rollback failed (BAK-11). */
  end(next: 'idle' | 'restore_failed') {
    this.current = next;
    if (next === 'idle') this.recovery = null;
  }

  /** Startup with a marker file or tests only: enter `restore_failed` directly. */
  fail(recovery: RecoverySession | null) {
    this.current = 'restore_failed';
    this.recovery = recovery;
  }
}
