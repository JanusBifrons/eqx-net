import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

/**
 * Main-thread read-only `node:sqlite` connection.
 *
 * Phase 7: the DB worker is the sole writer. The main thread opens this
 * connection in read-only mode for auth's synchronous SELECTs (login,
 * getUser, dev `/dev/stats`). Schema creation lives in the worker — we
 * assume the file already exists when this connection opens.
 *
 * Lazy-open: the connection isn't created until first access via the
 * `db` proxy below. `src/server/index.ts` calls `initWorker()` first, which
 * bootstraps the schema (by opening read/write inside the worker), so by
 * the time anything calls `db.prepare(...)` the file is guaranteed to exist.
 */
const dbPath = process.env['DB_PATH'] ?? path.resolve(process.cwd(), 'eqx.db');

let _conn: DatabaseSync | null = null;

function getConn(): DatabaseSync {
  if (_conn) return _conn;
  _conn = new DatabaseSync(dbPath, { readOnly: true });
  _conn.exec('PRAGMA foreign_keys=ON');
  return _conn;
}

/**
 * Proxy that opens the read-only connection on first use. Production callers
 * never construct directly — they `import { db }` and call `db.prepare(...)`.
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

/**
 * Internal: lets the auth subsystem and dev routes open a fresh read-only
 * connection if they need a private handle (e.g. for diag stats). Most code
 * should just use `db`.
 */
export function openReadOnly(): DatabaseSync {
  const conn = new DatabaseSync(dbPath, { readOnly: true });
  conn.exec('PRAGMA foreign_keys=ON');
  return conn;
}
