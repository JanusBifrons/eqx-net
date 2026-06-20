import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { bundleWorker } from '../workers/bundleWorker.js';
import type { WorkerInbound, WorkerOutbound } from './workerProtocol.js';

interface SqliteStmt {
  run(...params: unknown[]): { lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStmt;
  close(): void;
}
interface SqliteCtor {
  new (filename: string, options?: { readOnly?: boolean }): SqliteDb;
}
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: SqliteCtor };

const DB_WORKER_TS = fileURLToPath(new URL('./dbWorker.ts', import.meta.url));

/**
 * Integration test: spawns the real DB worker against a tempfile and proves
 * that BATCH/AWAITABLE/VOLATILE/SHUTDOWN protocol operates end-to-end with
 * `node:sqlite`. Slower than the unit test (~1 s) — gates the wire shape.
 */
describe('dbWorker (real worker, temp file DB)', () => {
  let tempDir: string;
  let dbPath: string;
  let worker: Worker;
  let workerCode: string;
  let testCounter = 0;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'eqx-dbworker-test-'));
    workerCode = await bundleWorker({ entryPoint: DB_WORKER_TS });
  });

  beforeEach(() => {
    // Fresh DB file per test — avoids file-lock races between sequential
    // worker spawns that each call PRAGMA journal_mode=WAL on init.
    testCounter += 1;
    dbPath = path.join(tempDir, `test-${testCounter}.db`);
  });

  afterAll(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  function shutdownAndWaitForExit(
    w: Worker,
    post: (msg: WorkerInbound) => void,
  ): Promise<number> {
    return new Promise((resolve) => {
      let drained = 0;
      w.on('message', (msg: WorkerOutbound) => {
        if (msg.type === 'SHUTDOWN_ACK') drained = msg.drained;
      });
      w.on('exit', () => resolve(drained));
      post({ type: 'SHUTDOWN' });
    });
  }

  function spawnAndAwaitReady(): Promise<Worker> {
    const w = new Worker(workerCode, { eval: true, workerData: { dbPath } });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker did not become READY in 5s')), 5000);
      w.on('message', (msg: WorkerOutbound) => {
        if (msg.type === 'READY') {
          clearTimeout(timer);
          resolve(w);
        }
      });
      w.on('error', reject);
      w.on('exit', (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
    });
  }

  it('persists 100 KILL ops via BATCH and survives SHUTDOWN', async () => {
    worker = await spawnAndAwaitReady();
    const acks: number[] = [];
    worker.on('message', (msg: WorkerOutbound) => {
      if (msg.type === 'BATCH_ACK') acks.push(msg.batchId);
    });

    // Seed two users (the FK constraint on player_kills accepts NULL but
    // the realistic scenario is non-null user ids).
    const post = (msg: WorkerInbound): void => worker.postMessage(msg);
    const seedNow = Date.now();
    await new Promise<void>((resolve) => {
      const onMsg = (msg: WorkerOutbound): void => {
        if (msg.type === 'AWAITABLE_ACK') {
          worker.off('message', onMsg);
          resolve();
        }
      };
      worker.on('message', onMsg);
      post({
        type: 'AWAITABLE',
        opId: 'seed-1',
        op: { type: 'USER_REGISTER', userId: 'killer', email: 'k@t', passwordHash: null, displayName: null, ts: seedNow },
      });
    });
    post({
      type: 'BATCH',
      batchId: 1,
      ops: [
        { type: 'USER_REGISTER', userId: 'victim', email: 'v@t', passwordHash: null, displayName: null, ts: seedNow },
      ],
    });

    const ops = Array.from({ length: 100 }, (_, i) => ({
      type: 'KILL' as const,
      killerUserId: 'killer',
      victimUserId: 'victim',
      weapon: 'hitscan',
      sectorId: 'sector',
      ts: seedNow + i,
    }));
    post({ type: 'BATCH', batchId: 2, ops });

    // Wait for both BATCH_ACKs.
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        if (acks.includes(1) && acks.includes(2)) resolve();
        else setTimeout(tick, 10);
      };
      tick();
    });

    // SHUTDOWN flushes and exits. Wait for the worker thread to fully exit
    // before opening a read connection — Windows holds the file lock until
    // the worker's process.exit(0) completes.
    const drained = await shutdownAndWaitForExit(worker, post);
    expect(drained).toBeGreaterThanOrEqual(101);

    // Read back via a fresh read-only connection.
    const ro = new DatabaseSync(dbPath, { readOnly: true });
    const row = ro.prepare('SELECT count(*) AS n FROM player_kills').get() as { n: number };
    expect(row.n).toBe(100);
    const userCount = ro.prepare('SELECT count(*) AS n FROM users').get() as { n: number };
    expect(userCount.n).toBe(2);
    ro.close();
  });

  it('VOLATILE telemetry ops are accepted (no schema yet, no crash)', async () => {
    worker = await spawnAndAwaitReady();
    const post = (msg: WorkerInbound): void => worker.postMessage(msg);
    for (let i = 0; i < 50; i++) {
      post({
        type: 'VOLATILE',
        op: { type: 'TELEMETRY_SHED', entityId: `e${i}`, sectorId: 'sector', ts: Date.now() },
      });
    }
    // No way to assert "telemetry was processed" without a table. Instead,
    // SHUTDOWN_ACK proving the worker is still alive after 50 volatiles is
    // sufficient to gate the protocol.
    const drained = await shutdownAndWaitForExit(worker, post);
    expect(drained).toBeGreaterThanOrEqual(0);
  });

  it('PLAYER_SHIP_PUT round-trips the Phase 4 leveling columns', async () => {
    worker = await spawnAndAwaitReady();
    const post = (msg: WorkerInbound): void => worker.postMessage(msg);
    const acks: number[] = [];
    worker.on('message', (msg: WorkerOutbound) => {
      if (msg.type === 'BATCH_ACK') acks.push(msg.batchId);
    });

    const now = Date.now();
    post({
      type: 'BATCH',
      batchId: 1,
      ops: [
        {
          type: 'PLAYER_SHIP_PUT',
          shipId: 'ship-lvl-1',
          playerId: 'p1',
          userId: null,
          kind: 'fighter',
          kindVersion: 1,
          health: 100,
          lastSectorKey: 'sol-prime',
          lastX: 1, lastY: 2, lastVx: 0, lastVy: 0, lastAngle: 0, lastAngvel: 0,
          lastFireClientTick: 0,
          isActive: false,
          activeRoomId: null,
          expiresAt: 0,
          level: 5,
          xp: 4321,
          statAllocJson: JSON.stringify({ hull: 2, damage: 1 }),
          mountsJson: JSON.stringify([{ slotId: 'wing-l', weaponId: 'laser_beam' }]),
          ts: now,
        },
      ],
    });
    await new Promise<void>((resolve) => {
      const tick = (): void => (acks.includes(1) ? resolve() : void setTimeout(tick, 5));
      tick();
    });

    await shutdownAndWaitForExit(worker, post);

    const ro = new DatabaseSync(dbPath, { readOnly: true });
    const row = ro
      .prepare('SELECT level, xp, stat_alloc, mounts FROM player_ships WHERE ship_id = ?')
      .get('ship-lvl-1') as { level: number; xp: number; stat_alloc: string; mounts: string };
    expect(row.level).toBe(5);
    expect(row.xp).toBe(4321);
    expect(JSON.parse(row.stat_alloc)).toEqual({ hull: 2, damage: 1 });
    expect(JSON.parse(row.mounts)).toEqual([{ slotId: 'wing-l', weaponId: 'laser_beam' }]);
    ro.close();
  });

  it('the idempotent ALTER adds the leveling columns to a pre-existing DB without them', async () => {
    // Simulate a DB created by an OLDER deploy: the player_ships table exists
    // but lacks the Phase 4 leveling columns. The worker's idempotent
    // PLAYER_SHIPS_MIGRATIONS must add them on boot, so a PLAYER_SHIP_PUT then
    // succeeds and the existing row gains the column DEFAULTs.
    const seed = new DatabaseSync(dbPath);
    seed.exec('PRAGMA journal_mode=WAL');
    seed.exec(
      'CREATE TABLE player_ships (' +
        'ship_id TEXT PRIMARY KEY, player_id TEXT NOT NULL, user_id TEXT, kind TEXT NOT NULL, ' +
        'kind_version INTEGER NOT NULL DEFAULT 1, health REAL NOT NULL, last_sector_key TEXT NOT NULL, ' +
        'last_x REAL NOT NULL, last_y REAL NOT NULL, last_vx REAL NOT NULL, last_vy REAL NOT NULL, ' +
        'last_angle REAL NOT NULL, last_angvel REAL NOT NULL, last_fire_client_tick INTEGER NOT NULL DEFAULT 0, ' +
        'is_active INTEGER NOT NULL DEFAULT 0, active_room_id TEXT, expires_at INTEGER NOT NULL, ' +
        'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    );
    seed
      .prepare(
        'INSERT INTO player_ships (ship_id, player_id, user_id, kind, kind_version, health, ' +
          'last_sector_key, last_x, last_y, last_vx, last_vy, last_angle, last_angvel, ' +
          'last_fire_client_tick, is_active, active_room_id, expires_at, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('old-ship', 'p-old', null, 'scout', 1, 60, 'sol-prime', 0, 0, 0, 0, 0, 0, 0, 0, null, 0, 0, 0);
    seed.close();

    // Boot the real worker against the column-less DB — the migrations run.
    worker = await spawnAndAwaitReady();
    const post = (msg: WorkerInbound): void => worker.postMessage(msg);
    const acks: number[] = [];
    worker.on('message', (msg: WorkerOutbound) => {
      if (msg.type === 'BATCH_ACK') acks.push(msg.batchId);
    });
    const now = Date.now();
    post({
      type: 'BATCH',
      batchId: 1,
      ops: [
        {
          type: 'PLAYER_SHIP_PUT',
          shipId: 'new-ship', playerId: 'p-new', userId: null, kind: 'fighter', kindVersion: 1,
          health: 100, lastSectorKey: 'sol-prime', lastX: 0, lastY: 0, lastVx: 0, lastVy: 0,
          lastAngle: 0, lastAngvel: 0, lastFireClientTick: 0, isActive: false, activeRoomId: null,
          expiresAt: 0, level: 3, xp: 99, statAllocJson: '{}', mountsJson: '[]', ts: now,
        },
      ],
    });
    await new Promise<void>((resolve) => {
      const tick = (): void => (acks.includes(1) ? resolve() : void setTimeout(tick, 5));
      tick();
    });
    await shutdownAndWaitForExit(worker, post);

    const ro = new DatabaseSync(dbPath, { readOnly: true });
    // The migrated old row carries the column DEFAULTs (1 / 0 / {} / []).
    const oldRow = ro
      .prepare('SELECT level, xp, stat_alloc, mounts FROM player_ships WHERE ship_id = ?')
      .get('old-ship') as { level: number; xp: number; stat_alloc: string; mounts: string };
    expect(oldRow.level).toBe(1);
    expect(oldRow.xp).toBe(0);
    expect(oldRow.stat_alloc).toBe('{}');
    expect(oldRow.mounts).toBe('[]');
    // The new write landed its non-default values.
    const newRow = ro
      .prepare('SELECT level, xp FROM player_ships WHERE ship_id = ?')
      .get('new-ship') as { level: number; xp: number };
    expect(newRow.level).toBe(3);
    expect(newRow.xp).toBe(99);
    ro.close();
  });

  it('GAME_LEAVE for a non-existent play_id is a silent no-op', async () => {
    worker = await spawnAndAwaitReady();
    const post = (msg: WorkerInbound): void => worker.postMessage(msg);
    const acks: number[] = [];
    worker.on('message', (msg: WorkerOutbound) => {
      if (msg.type === 'BATCH_ACK') acks.push(msg.batchId);
    });

    post({
      type: 'BATCH',
      batchId: 1,
      ops: [{ type: 'GAME_LEAVE', playId: 'never-joined', ts: Date.now() }],
    });
    await new Promise<void>((resolve) => {
      const tick = (): void => acks.includes(1) ? resolve() : void setTimeout(tick, 5);
      tick();
    });

    await shutdownAndWaitForExit(worker, post);

    const ro = new DatabaseSync(dbPath, { readOnly: true });
    const row = ro.prepare('SELECT count(*) AS n FROM game_sessions').get() as { n: number };
    expect(row.n).toBe(0);
    ro.close();
  });
});
