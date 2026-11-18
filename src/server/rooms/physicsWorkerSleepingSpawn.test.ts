/**
 * Wreck fields slice 3a (plan review 3 "Sleeping spawn"): a SPAWN_OBSTACLE
 * with `sleeping` creates the body ASLEEP across the REAL physics-worker
 * boundary (#13: a boundary behaviour is tested at the boundary). Its first
 * step reports it asleep (FLAG_SLEEPING in the SAB, SLEEP_TRANSITION with
 * that tick: no 12-tick awake window) and it does not move, even with a
 * spawn velocity. A normal spawn of the same body is the control.
 *
 * Same harness as `physicsWorkerSetHullExposed.test.ts` (bundleWorker +
 * Rapier external + a SharedArrayBuffer).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { bundleWorker } from '../workers/bundleWorker.js';
import {
  SAB_TOTAL_BYTES, SEQLOCK_IDX, TICK_IDX, slotBase, SLOT_ID_OFF, SLOT_X_OFF, SLOT_Y_OFF, SLOT_FLAGS_OFF, FLAG_SLEEPING,
} from '../../shared-types/sabLayout.js';

const WORKER_TS = fileURLToPath(new URL('../../core/physics/worker.ts', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SQUARE = [[{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 20, y: 20 }, { x: -20, y: 20 }]];

describe('physics worker: sleeping SPAWN_OBSTACLE (real worker boundary)', () => {
  let worker: Worker;
  let u32: Uint32Array;
  let f32: Float32Array;
  const transitions: Array<{ entityId: string; sleeping: boolean; tick: number }> = [];

  beforeAll(async () => {
    const code = await bundleWorker({ entryPoint: WORKER_TS, external: ['@dimforge/rapier2d-compat'] });
    const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
    u32 = new Uint32Array(sab);
    f32 = new Float32Array(sab);
    worker = new Worker(code, { eval: true, workerData: { sab } });
    worker.on('message', (m: { type?: string; entityId?: string; sleeping?: boolean; tick?: number }) => {
      if (m.type === 'SLEEP_TRANSITION') transitions.push({ entityId: m.entityId!, sleeping: m.sleeping!, tick: m.tick! });
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('worker never READY')), 15_000);
      worker.on('message', (m: { type?: string }) => { if (m.type === 'READY') { clearTimeout(t); resolve(); } });
    });
  }, 30_000);

  afterAll(async () => { if (worker) await worker.terminate(); });

  /** Slot `slot`'s id, x, y and flags, read under the seqlock (retried). */
  async function readSlot(slot: number): Promise<{ id: number; x: number; y: number; flags: number }> {
    const base = slotBase(slot);
    const deadline = Date.now() + 2000;
    for (;;) {
      const s1 = Atomics.load(u32, SEQLOCK_IDX);
      if ((s1 & 1) === 0) {
        const r = { id: u32[base + SLOT_ID_OFF]!, x: f32[base + SLOT_X_OFF]!, y: f32[base + SLOT_Y_OFF]!, flags: u32[base + SLOT_FLAGS_OFF]! };
        if (Atomics.load(u32, SEQLOCK_IDX) === s1) return r;
      }
      if (Date.now() > deadline) throw new Error(`slot ${slot} never read cleanly`);
      await sleep(1);
    }
  }
  async function waitTicks(n: number): Promise<void> {
    const start = Atomics.load(u32, TICK_IDX);
    const deadline = Date.now() + 3000;
    while (Atomics.load(u32, TICK_IDX) < start + n) {
      if (Date.now() > deadline) throw new Error(`timed out waiting ${n} ticks`);
      await sleep(10);
    }
  }
  async function firstTransition(id: string, timeoutMs = 3000): Promise<{ sleeping: boolean; tick: number }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const t = transitions.find((x) => x.entityId === id);
      if (t) return t;
      if (Date.now() > deadline) throw new Error(`no SLEEP_TRANSITION for ${id}`);
      await sleep(5);
    }
  }
  const spawn = (slot: number, id: string, x: number, sleeping: boolean): void => {
    worker.postMessage({
      type: 'SPAWN_OBSTACLE', slot, obstacleId: id, x, y: 0, vx: 30, vy: 0, radius: 29, mass: 50,
      parts: SQUARE, angle: 0.4, angvel: 0, angularDamping: 0.05, linearDamping: 0.06, ...(sleeping ? { sleeping } : {}),
    });
  };

  it('is asleep from its first step (FLAG_SLEEPING, SLEEP_TRANSITION) and never moves', async () => {
    const before = Atomics.load(u32, TICK_IDX);
    spawn(0, 'wreck-s', 1000, true);
    const t = await firstTransition('wreck-s');
    expect(t.sleeping).toBe(true);
    // The command lands between steps; its first step reports it asleep
    // (a normal spawn waits the 12-tick hysteresis at the very least).
    expect(t.tick - before).toBeLessThanOrEqual(3);
    const st = await readSlot(0);
    expect(st.id).toBe(1);
    expect(st.flags & FLAG_SLEEPING).toBe(FLAG_SLEEPING);
    await waitTicks(20);
    const later = await readSlot(0);
    expect(later.flags & FLAG_SLEEPING).toBe(FLAG_SLEEPING);
    expect(later.x).toBeCloseTo(1000, 3); // the spawn velocity never applied
    expect(later.y).toBeCloseTo(0, 3);
    expect(transitions.filter((x) => x.entityId === 'wreck-s').length, 'never woke').toBe(1);
  });

  it('control: the same body spawned awake moves and is not asleep for the hysteresis window', async () => {
    const before = Atomics.load(u32, TICK_IDX);
    spawn(1, 'wreck-a', -1000, false);
    await waitTicks(13);
    const st = await readSlot(1);
    expect(st.id).toBe(2);
    expect(st.flags & FLAG_SLEEPING).toBe(0);
    expect(st.x).toBeGreaterThan(-1000 + 1);
    const t = transitions.find((x) => x.entityId === 'wreck-a');
    if (t !== undefined) expect(t.tick - before).toBeGreaterThanOrEqual(12);
  });
});
