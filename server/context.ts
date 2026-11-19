/**
 * What the server's routes read their state from (SRV-3). The database, the
 * resolved configuration and the setup password join it in later sub-issues
 * of #6 (#10, #11).
 */
export interface AppContext {
  /** The app version from `package.json` (VER-2). */
  version: string;
}
