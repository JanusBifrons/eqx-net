import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { SCHEMA_SQL } from './schema.js';
import { SyncSinkAdapter } from './SyncSinkAdapter.js';

// Stub the module-level `db` from Database.ts so the production singleton
// in PersistenceWorker.ts can construct without opening eqx.db on disk.
// The stub is unused — every test calls `setPersistence(...)` to swap in a
// fresh `:memory:`-backed adapter before any StatsService function runs.
vi.mock('./Database.js', () => ({ db: { prepare: () => ({ run: () => ({}), get: () => null, all: () => [] }), exec: () => {} } }));

const { setPersistence, getPersistence } = await import('./PersistenceWorker.js');
const {
  recordLoginEvent,
  recordGameJoin,
  recordGameLeave,
  recordKill,
  saveSnapshot,
} = await import('../stats/StatsService.js');

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

/**
 * End-to-end of the sub-phase-A persistence seam: drives StatsService through
 * the singleton sink (set to a `:memory:`-backed adapter for the test), then
 * verifies all rows landed exactly as the legacy direct-`db.prepare` path
 * would have produced. This is the test that replaces the manual smoke step
 * (register → join → kill → leave → check eqx.db) with something repeatable.
 */
describe('persistence flow (StatsService → sink → DB)', () => {
  let db: SqliteDb;
  let prevSink: ReturnType<typeof getPersistence>;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    prevSink = getPersistence();
    setPersistence(new SyncSinkAdapter(db));
  });

  afterEach(() => {
    setPersistence(prevSink);
  });

  it('full join → kill → leave flow lands every row in the right table', () => {
    // Seed two users (mimicking AuthService.register, but via the sink).
    const sink = getPersistence();
    sink.enqueueCritical({
      type: 'USER_REGISTER',
      userId: 'killer-id',
      email: 'killer@e2e.test',
      passwordHash: null,
      displayName: 'Killer',
      ts: 1000,
    });
    sink.enqueueCritical({
      type: 'USER_REGISTER',
      userId: 'victim-id',
      email: 'victim@e2e.test',
      passwordHash: null,
      displayName: 'Victim',
      ts: 1000,
    });

    recordLoginEvent('killer@e2e.test', 'killer-id', true, 'local', '127.0.0.1');
    recordLoginEvent('victim@e2e.test', 'victim-id', true, 'local', '127.0.0.1');

    recordGameJoin('killer-id', 'play-killer', 'sector');
    recordGameJoin('victim-id', 'play-victim', 'sector');

    recordKill('killer-id', 'victim-id', 'hitscan', 'sector');

    saveSnapshot('sector', { tick: 42, ships: 2 });

    recordGameLeave('play-killer');
    recordGameLeave('play-victim');

    const users = db.prepare('SELECT count(*) AS n FROM users').get() as { n: number };
    expect(users.n).toBe(2);

    const logins = db
      .prepare('SELECT count(*) AS n FROM login_events WHERE success = 1')
      .get() as { n: number };
    expect(logins.n).toBe(2);

    const sessions = db
      .prepare('SELECT play_id, joined_at, left_at FROM game_sessions ORDER BY play_id')
      .all() as Array<{ play_id: string; joined_at: number; left_at: number | null }>;
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.play_id).toBe('play-killer');
    expect(sessions[0]!.left_at).not.toBeNull();
    expect(sessions[1]!.play_id).toBe('play-victim');
    expect(sessions[1]!.left_at).not.toBeNull();

    const kill = db
      .prepare('SELECT killer_user_id, victim_user_id, weapon, sector_id FROM player_kills')
      .get() as { killer_user_id: string; victim_user_id: string; weapon: string; sector_id: string };
    expect(kill).toEqual({
      killer_user_id: 'killer-id',
      victim_user_id: 'victim-id',
      weapon: 'hitscan',
      sector_id: 'sector',
    });

    const snap = db
      .prepare('SELECT sector_id, snapshot FROM game_snapshots')
      .get() as { sector_id: string; snapshot: string };
    expect(snap.sector_id).toBe('sector');
    expect(JSON.parse(snap.snapshot)).toEqual({ tick: 42, ships: 2 });
  });

  it('GAME_LEAVE for a play_id with no JOIN row is a silent no-op (idempotent leave)', () => {
    recordGameLeave('never-joined');
    const sessions = db.prepare('SELECT count(*) AS n FROM game_sessions').get() as { n: number };
    expect(sessions.n).toBe(0);
  });

  it('multiple kills in a sector accumulate without coalescing in the sync adapter', () => {
    const sink = getPersistence();
    sink.enqueueCritical({
      type: 'USER_REGISTER',
      userId: 'k',
      email: 'k@t',
      passwordHash: null,
      displayName: null,
      ts: 1,
    });
    sink.enqueueCritical({
      type: 'USER_REGISTER',
      userId: 'v',
      email: 'v@t',
      passwordHash: null,
      displayName: null,
      ts: 1,
    });
    for (let i = 0; i < 25; i++) {
      recordKill('k', 'v', 'hitscan', 'sector');
    }
    const row = db.prepare('SELECT count(*) AS n FROM player_kills').get() as { n: number };
    expect(row.n).toBe(25);
  });
});
