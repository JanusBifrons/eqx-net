import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';

// PersistenceWorker imports Database.ts → node:sqlite, which vite can't resolve
// in the test env. Stub it (same pattern as diagRouter.test.ts); StatsService
// only needs the persistence sink, which we swap via setPersistence.
vi.mock('../db/Database.js', () => ({
  db: { prepare: () => ({ get: () => null, run: () => ({}), all: () => [] }), exec: () => {} },
}));

import { setPersistence } from '../db/PersistenceWorker.js';
import {
  recordLoginEvent,
  recordGameJoin,
  recordGameLeave,
  recordKill,
  saveSnapshot,
} from './StatsService.js';

function makeSink(): IPersistenceSink & { ops: PersistOp[] } {
  const ops: PersistOp[] = [];
  return {
    ops,
    enqueueCritical(op) { ops.push(op); },
    enqueueVolatile(op) { ops.push(op); },
    enqueueCriticalAwaitable(op) { ops.push(op); return Promise.resolve({}); },
    shutdown() { return Promise.resolve({ drained: 0 }); },
  };
}

describe('StatsService', () => {
  let sink: ReturnType<typeof makeSink>;
  beforeEach(() => {
    sink = makeSink();
    setPersistence(sink);
  });

  it('recordLoginEvent enqueues a LOGIN_EVENT op with the supplied fields', () => {
    recordLoginEvent('a@test.local', 'u1', true, 'local', '1.2.3.4');
    expect(sink.ops).toHaveLength(1);
    expect(sink.ops[0]).toMatchObject({
      type: 'LOGIN_EVENT', email: 'a@test.local', userId: 'u1', success: true, provider: 'local', ip: '1.2.3.4',
    });
  });

  it('recordGameJoin / recordGameLeave correlate by playId', () => {
    recordGameJoin('u1', 'play-1', 'sol-prime');
    recordGameLeave('play-1');
    expect(sink.ops[0]).toMatchObject({ type: 'GAME_JOIN', playId: 'play-1', sectorId: 'sol-prime' });
    expect(sink.ops[1]).toMatchObject({ type: 'GAME_LEAVE', playId: 'play-1' });
  });

  it('recordKill enqueues a KILL op', () => {
    recordKill('killer', 'victim', 'hitscan', 'sol-prime');
    expect(sink.ops[0]).toMatchObject({ type: 'KILL', killerUserId: 'killer', victimUserId: 'victim', weapon: 'hitscan' });
  });

  it('saveSnapshot serialises state to payloadJson', () => {
    saveSnapshot('sol-prime', { drones: 3 });
    const op = sink.ops[0] as { type: string; payloadJson: string };
    expect(op.type).toBe('SNAPSHOT');
    expect(JSON.parse(op.payloadJson)).toEqual({ drones: 3 });
  });

  it('stamps a ts on every op', () => {
    recordGameLeave('play-x');
    expect(typeof (sink.ops[0] as { ts: number }).ts).toBe('number');
  });
});
