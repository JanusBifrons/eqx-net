import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { SCHEMA_SQL } from './schema.js';
import { SyncSinkAdapter } from './SyncSinkAdapter.js';

// vite 5.4.21's resolver doesn't recognise `node:sqlite` (added in Node 22.5+
// and stable in v24), so we bypass vite entirely with `createRequire`.
// Production code imports `node:sqlite` natively (tsx + Node handle it fine).
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
  };
}
interface SqliteCtor {
  new (filename: string, options?: { readOnly?: boolean }): SqliteDb;
}
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: SqliteCtor };

describe('SyncSinkAdapter', () => {
  let db: SqliteDb;
  let sink: SyncSinkAdapter;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    sink = new SyncSinkAdapter(db);
  });

  it('enqueueCritical persists KILL ops to player_kills', () => {
    for (let i = 0; i < 10; i++) {
      sink.enqueueCritical({
        type: 'KILL',
        killerUserId: null,
        victimUserId: null,
        weapon: 'hitscan',
        sectorId: 'sector',
        ts: Date.now(),
      });
    }
    const row = db.prepare('SELECT count(*) AS n FROM player_kills').get() as { n: number };
    expect(row.n).toBe(10);
  });

  it('GAME_LEAVE matches the GAME_JOIN row by play_id', () => {
    const now = Date.now();
    sink.enqueueCritical({
      type: 'GAME_JOIN',
      userId: null,
      playId: 'alpha',
      sectorId: 'sector',
      ts: now,
    });
    sink.enqueueCritical({ type: 'GAME_LEAVE', playId: 'alpha', ts: now + 1000 });
    const row = db
      .prepare('SELECT joined_at, left_at FROM game_sessions WHERE play_id = ?')
      .get('alpha') as { joined_at: number; left_at: number | null };
    expect(row.left_at).toBe(now + 1000);
  });

  it('enqueueCriticalAwaitable resolves with the inserted rowId for USER_REGISTER', async () => {
    const result = await sink.enqueueCriticalAwaitable({
      type: 'USER_REGISTER',
      userId: 'u1',
      email: 'a@b.test',
      passwordHash: 'h',
      displayName: 'Alpha',
      ts: Date.now(),
    });
    expect(result.rowId).toBeTypeOf('number');
    const row = db.prepare('SELECT id FROM users WHERE email = ?').get('a@b.test') as { id: string };
    expect(row.id).toBe('u1');
  });

  it('USER_PROVIDER honours ignoreConflict on duplicate provider/provider_id', () => {
    sink.enqueueCritical({
      type: 'USER_REGISTER',
      userId: 'u1',
      email: 'a@b.test',
      passwordHash: null,
      displayName: null,
      ts: Date.now(),
    });
    sink.enqueueCritical({
      type: 'USER_PROVIDER',
      providerRowId: 'p1',
      userId: 'u1',
      provider: 'google',
      providerId: 'g-123',
    });
    // Without ignoreConflict, a duplicate would throw.
    expect(() =>
      sink.enqueueCritical({
        type: 'USER_PROVIDER',
        providerRowId: 'p2',
        userId: 'u1',
        provider: 'google',
        providerId: 'g-123',
      }),
    ).toThrow();
    // With ignoreConflict, the duplicate is silently dropped.
    expect(() =>
      sink.enqueueCritical({
        type: 'USER_PROVIDER',
        providerRowId: 'p3',
        userId: 'u1',
        provider: 'google',
        providerId: 'g-123',
        ignoreConflict: true,
      }),
    ).not.toThrow();
    const row = db
      .prepare('SELECT count(*) AS n FROM auth_providers WHERE provider = ? AND provider_id = ?')
      .get('google', 'g-123') as { n: number };
    expect(row.n).toBe(1);
  });

  it('TELEMETRY_* ops are no-ops in the sync adapter (no schema yet)', () => {
    expect(() =>
      sink.enqueueVolatile({
        type: 'TELEMETRY_SHED',
        entityId: 'swarm-1',
        sectorId: 'sector',
        ts: Date.now(),
      }),
    ).not.toThrow();
    expect(() =>
      sink.enqueueVolatile({
        type: 'TELEMETRY_SLEEP',
        entityId: 'swarm-1',
        sleeping: true,
        sectorId: 'sector',
        ts: Date.now(),
      }),
    ).not.toThrow();
  });

  it('shutdown resolves immediately with drained=0', async () => {
    const result = await sink.shutdown({ timeoutMs: 1000 });
    expect(result.drained).toBe(0);
  });
});
