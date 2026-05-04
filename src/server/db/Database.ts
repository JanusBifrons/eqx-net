import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

/**
 * Main-thread `node:sqlite` connection — used for SELECT-only paths (auth
 * login, getUser, dev `/dev/stats`).
 *
 * Phase 7: the DB worker (`dbWorker.ts`) is the sole writer. The main thread
 * never calls `.run()` for writes — those flow through `IPersistenceSink`.
 * The connection here is opened in normal (read-write) mode rather than
 * `readOnly: true` because Node's `node:sqlite` read-only mode does not
 * always observe WAL writes from a sibling connection in the same process —
 * tests on Node v24 saw INSERTs from the worker invisible to a `readOnly`
 * reader. Read-write mode shares the WAL/SHM correctly. The single-writer
 * invariant is enforced by code discipline (lint-able in future if needed),
 * not by the open flag.
 *
 * Lazy-open: the connection isn't created until first access via the proxy.
 * `src/server/index.ts` calls `initWorker()` first, which bootstraps the
 * schema inside the worker, so by the time anything calls `db.prepare(...)`
 * the file is guaranteed to exist.
 */
const dbPath = process.env['DB_PATH'] ?? path.resolve(process.cwd(), 'eqx.db');

let _conn: DatabaseSync | null = null;

function getConn(): DatabaseSync {
  if (_conn) return _conn;
  _conn = new DatabaseSync(dbPath);
  _conn.exec('PRAGMA foreign_keys=ON');
  return _conn;
}

/**
 * Proxy that opens the connection on first use. Production callers never
 * construct directly — they `import { db }` and call `db.prepare(...)`.
 *
 * Tests that exercise auth's read paths inject a `:memory:` `DatabaseSync`
 * via `vi.mock('./Database.js', ...)`; tests that don't touch reads never
 * trigger the open.
 */
export const db: DatabaseSync = new Proxy({} as DatabaseSync, {
  get(_t, k) {
    const real = getConn();
    const v = (real as unknown as Record<string, unknown>)[k as string];
    if (typeof v === 'function') return v.bind(real);
    return v;
  },
});
