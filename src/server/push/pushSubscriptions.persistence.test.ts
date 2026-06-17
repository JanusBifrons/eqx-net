import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { SCHEMA_SQL } from '../db/schema.js';
import { SyncSinkAdapter } from '../db/SyncSinkAdapter.js';

interface SqliteStmt {
  run(...params: unknown[]): { lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStmt;
}
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (filename: string) => SqliteDb;
};

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  const sink = new SyncSinkAdapter(db as never);
  // push_subscriptions.user_id has a FK to users(id) (enforced by node:sqlite),
  // so seed the owning user before inserting subscriptions.
  sink.enqueueCritical({
    type: 'USER_REGISTER',
    userId: 'u1',
    email: 'u1@test.local',
    passwordHash: null,
    displayName: null,
    ts: 0,
  });
  return { db, sink };
}

describe('push_subscriptions persistence (schema + SyncSinkAdapter statements)', () => {
  it('PUSH_SUBSCRIPTION_PUT inserts a row readable by user_id', () => {
    const { db, sink } = setup();
    sink.enqueueCritical({
      type: 'PUSH_SUBSCRIPTION_PUT',
      subscriptionId: 's1',
      userId: 'u1',
      endpoint: 'https://push/abc',
      p256dh: 'k1',
      auth: 'a1',
      ts: 1,
    });
    const rows = db
      .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
      .all('u1');
    expect(rows).toEqual([{ endpoint: 'https://push/abc', p256dh: 'k1', auth: 'a1' }]);
  });

  it('a second PUT on the same endpoint UPSERTs (no duplicate, keys updated)', () => {
    const { db, sink } = setup();
    sink.enqueueCritical({ type: 'PUSH_SUBSCRIPTION_PUT', subscriptionId: 's1', userId: 'u1', endpoint: 'https://push/abc', p256dh: 'k1', auth: 'a1', ts: 1 });
    sink.enqueueCritical({ type: 'PUSH_SUBSCRIPTION_PUT', subscriptionId: 's2', userId: 'u1', endpoint: 'https://push/abc', p256dh: 'k2', auth: 'a2', ts: 2 });
    const rows = db
      .prepare('SELECT p256dh, auth FROM push_subscriptions WHERE endpoint = ?')
      .all('https://push/abc');
    expect(rows).toEqual([{ p256dh: 'k2', auth: 'a2' }]);
  });

  it('PUSH_SUBSCRIPTION_DELETE removes the row by endpoint', () => {
    const { db, sink } = setup();
    sink.enqueueCritical({ type: 'PUSH_SUBSCRIPTION_PUT', subscriptionId: 's1', userId: 'u1', endpoint: 'https://push/abc', p256dh: 'k1', auth: 'a1', ts: 1 });
    sink.enqueueCritical({ type: 'PUSH_SUBSCRIPTION_DELETE', endpoint: 'https://push/abc', ts: 3 });
    const n = db.prepare('SELECT count(*) AS n FROM push_subscriptions').get() as { n: number };
    expect(n.n).toBe(0);
  });
});
