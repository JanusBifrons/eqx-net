/**
 * The physics worker pool (memory, 2026-11-07): one worker hosts several
 * sector worlds. Through the REAL worker boundary: two worlds on one worker
 * each tick their own SAB and bodies without crosstalk, messages route to the
 * right world, and a detached world stops while the other keeps running.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { PhysicsWorkerPool, physicsPoolSize, type PooledWorkerMsg } from './PhysicsWorkerPool.js';
import { SAB_TOTAL_BYTES, TICK_IDX, SEQLOCK_IDX, SLOT_ID_OFF, SLOT_X_OFF, slotBase } from '../../shared-types/sabLayout.js';

const WORKER_TS = fileURLToPath(new URL('../../core/physics/worker.ts', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function sabView(): { sab: SharedArrayBuffer; u32: Uint32Array; f32: Float32Array } {
  const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
  return { sab, u32: new Uint32Array(sab), f32: new Float32Array(sab) };
}
function readX(v: { u32: Uint32Array; f32: Float32Array }, slot: number): number | null {
  for (let i = 0; i < 100; i++) {
    const s1 = Atomics.load(v.u32, SEQLOCK_IDX);
    if (s1 & 1) continue;
    const id = v.u32[slotBase(slot) + SLOT_ID_OFF]!;
    const x = v.f32[slotBase(slot) + SLOT_X_OFF]!;
    if (Atomics.load(v.u32, SEQLOCK_IDX) === s1) return id === slot + 1 ? x : null;
  }
  return null;
}
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await sleep(15); }
}

describe('PhysicsWorkerPool', () => {
  const pool = new PhysicsWorkerPool(WORKER_TS, 1, pino({ level: 'silent' }));
  afterAll(async () => { await sleep(50); });

  it('hosts two worlds on one worker, each ticking its own SAB with no crosstalk', { timeout: 30_000 }, async () => {
    const a = sabView(), b = sabView();
    const msgsA: PooledWorkerMsg[] = [], msgsB: PooledWorkerMsg[] = [];
    const wa = await pool.attach(a.sab, (m) => msgsA.push(m));
    const wb = await pool.attach(b.sab, (m) => msgsB.push(m));
    expect(wa.workerIndex).toBe(wb.workerIndex); // pool of 1: same worker
    expect(pool.stats()).toEqual([{ index: 0, worlds: 2 }]);

    // A ship in each world, same slot, different places and velocities.
    wa.post({ type: 'SPAWN', slot: 0, playerId: 'p', x: 100, y: 0, kindId: 'fighter' } as { type: string });
    wb.post({ type: 'SPAWN', slot: 0, playerId: 'p', x: -500, y: 0, kindId: 'fighter' } as { type: string });
    await until(() => readX(a, 0) !== null && readX(b, 0) !== null);
    wb.post({ type: 'SET_POSITION', entityId: 'p', x: -500, y: 0, angle: 0, vx: 120, vy: 0, angvel: 0 } as { type: string });
    const t0a = Atomics.load(a.u32, TICK_IDX), t0b = Atomics.load(b.u32, TICK_IDX);
    await sleep(400);
    expect(Atomics.load(a.u32, TICK_IDX)).toBeGreaterThan(t0a + 10);
    expect(Atomics.load(b.u32, TICK_IDX)).toBeGreaterThan(t0b + 10);
    expect(readX(a, 0)).toBeCloseTo(100, 0); // A untouched by B's command
    expect(readX(b, 0)!).toBeGreaterThan(-480); // B moved

    // Detach A: it stops; B keeps ticking.
    wa.detach();
    expect(pool.stats()).toEqual([{ index: 0, worlds: 1 }]);
    await sleep(100);
    const ta = Atomics.load(a.u32, TICK_IDX), tb = Atomics.load(b.u32, TICK_IDX);
    await sleep(300);
    expect(Atomics.load(a.u32, TICK_IDX)).toBe(ta);
    expect(Atomics.load(b.u32, TICK_IDX)).toBeGreaterThan(tb + 10);
    wb.detach();
  });

  it('sizes from EQX_PHYSICS_WORKERS, per-room restores one worker per sector', () => {
    expect(physicsPoolSize({ EQX_PHYSICS_WORKERS: '2' })).toBe(2);
    expect(physicsPoolSize({ EQX_PHYSICS_WORKERS: 'per-room' })).toBe(Number.POSITIVE_INFINITY);
    expect(physicsPoolSize({})).toBeGreaterThanOrEqual(1);
    expect(physicsPoolSize({})).toBeLessThanOrEqual(4);
  });
});
