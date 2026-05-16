/**
 * Phase 2b lock — SET_HULL_EXPOSED across the REAL physics-worker
 * postMessage boundary (invariant #13: a boundary bug must be tested at
 * the boundary, not in a unit harness). Spawns the production physics
 * worker exactly the way `SectorRoom.spawnWorker` does (bundleWorker +
 * Rapier external + a SharedArrayBuffer) and drives
 * SPAWN → SET_HULL_EXPOSED(true) → AI_INTENT → SET_HULL_EXPOSED(false)
 * over the wire, asserting the worker never crashes, keeps stepping, and
 * the body stays a live dynamic body (responds to an impulse) AFTER the
 * collider swap — i.e. the pinned mass survives the swap through the real
 * worker code path.
 *
 * Lives in src/server (not src/core) because it uses the server-zone
 * `bundleWorker` util — same placement rationale as
 * `src/server/db/dbWorker.integration.test.ts`. Runs in the main
 * `pnpm test` suite (no Colyseus needed, so not under tests/integration).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { bundleWorker } from '../workers/bundleWorker.js';
import {
  SAB_TOTAL_BYTES,
  SEQLOCK_IDX,
  TICK_IDX,
  slotBase,
  SLOT_ID_OFF,
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
} from '../../shared-types/sabLayout.js';

const WORKER_TS = fileURLToPath(new URL('../../core/physics/worker.ts', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('physics worker — SET_HULL_EXPOSED (real worker boundary)', () => {
  let worker: Worker;
  let u32: Uint32Array;
  let f32: Float32Array;
  const errors: Error[] = [];
  let exited = false;

  beforeAll(async () => {
    const code = await bundleWorker({
      entryPoint: WORKER_TS,
      external: ['@dimforge/rapier2d-compat'],
    });
    const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
    u32 = new Uint32Array(sab);
    f32 = new Float32Array(sab);
    worker = new Worker(code, { eval: true, workerData: { sab } });
    worker.on('error', (e) => errors.push(e));
    worker.on('exit', () => { exited = true; });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('worker never READY')), 15_000);
      worker.on('message', (m: { type?: string }) => {
        if (m && m.type === 'READY') { clearTimeout(t); resolve(); }
      });
    });
  }, 30_000);

  afterAll(async () => {
    if (worker) await worker.terminate();
  });

  function readSlot(slot: number): { id: number; x: number; y: number; vx: number } | null {
    const base = slotBase(slot);
    for (let i = 0; i < 100; i++) {
      const s1 = Atomics.load(u32, SEQLOCK_IDX);
      if (s1 & 1) continue; // mid-write
      const id = u32[base + SLOT_ID_OFF]!;
      const x = f32[base + SLOT_X_OFF]!;
      const y = f32[base + SLOT_Y_OFF]!;
      const vx = f32[base + SLOT_VX_OFF]!;
      if (Atomics.load(u32, SEQLOCK_IDX) === s1) return { id, x, y, vx };
    }
    return null;
  }

  async function waitTicks(n: number, timeoutMs = 3000): Promise<void> {
    const start = Atomics.load(u32, TICK_IDX);
    const deadline = Date.now() + timeoutMs;
    while (Atomics.load(u32, TICK_IDX) < start + n) {
      if (Date.now() > deadline) throw new Error(`timed out waiting ${n} ticks`);
      await sleep(15);
    }
  }
  async function waitSlotOccupied(slot: number, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (u32[slotBase(slot) + SLOT_ID_OFF] !== slot + 1) {
      if (Date.now() > deadline) throw new Error(`slot ${slot} never occupied`);
      await sleep(15);
    }
  }

  it('handles the collider swap over the wire without crashing; body stays dynamic', async () => {
    // 1. Spawn a fighter; it should settle at its spawn pose (no forces).
    worker.postMessage({ type: 'SPAWN', slot: 0, playerId: 's', x: 300, y: 400, kindId: 'fighter' });
    await waitSlotOccupied(0);
    await waitTicks(5);
    let st = readSlot(0)!;
    expect(st.id).toBe(1); // slot 0 ⇒ slotId = slot + 1
    expect(st.x).toBeCloseTo(300, 0);
    expect(st.y).toBeCloseTo(400, 0);

    // 2. Expose the hull polygon over the wire. Worker must not crash and
    //    must keep stepping; the swap must not perturb / NaN the pose.
    worker.postMessage({ type: 'SET_HULL_EXPOSED', id: 's', exposed: true, kindId: 'fighter', tick: 0 });
    await waitTicks(6);
    expect(exited).toBe(false);
    expect(errors).toHaveLength(0);
    st = readSlot(0)!;
    expect(st.id).toBe(1);
    expect(Number.isFinite(st.x) && Number.isFinite(st.y)).toBe(true);
    expect(st.x).toBeCloseTo(300, 0);

    // 3. While the hull is exposed, an impulse must still move the body —
    //    proves mass is pinned through the real worker swap path (a broken
    //    mass model would leave inverse-mass 0 ⇒ no response).
    worker.postMessage({ type: 'AI_INTENT', slot: 0, fx: 120, fy: 0, torque: 0 });
    await waitTicks(8);
    st = readSlot(0)!;
    expect(st.vx).toBeGreaterThan(0);
    expect(st.x).toBeGreaterThan(300);

    // 4. Swap back to the circle — still alive, still stepping.
    worker.postMessage({ type: 'SET_HULL_EXPOSED', id: 's', exposed: false, kindId: 'fighter', tick: 0 });
    await waitTicks(5);
    expect(exited).toBe(false);
    expect(errors).toHaveLength(0);
    expect(readSlot(0)!.id).toBe(1);
  }, 20_000);
});
