/**
 * Phase A1 — node:sqlite stub for the integration test harness.
 *
 * `src/server/db/Database.ts` does `import { DatabaseSync } from 'node:sqlite'`
 * and exports `db` (a lazy-opened read-only connection). The integration
 * tests don't touch SQLite — they stub PlayerShipStore / LimboStore /
 * persistence via the `setX` test seams — but the transitive import
 * still loads at module-init, and Vite's resolver mishandles the
 * `node:` prefix in some configurations, failing with
 * "Failed to load url sqlite".
 *
 * This stub provides a no-op `DatabaseSync` that satisfies the import
 * shape without actually opening a database. The vitest config aliases
 * `node:sqlite` to this file for integration tests.
 */
export class DatabaseSync {
  constructor(_path: string, _opts?: unknown) {}
  prepare(_sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): { changes: number; lastInsertRowid: number };
  } {
    return {
      all: () => [],
      get: () => null,
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
    };
  }
  exec(_sql: string): void {}
  close(): void {}
}
