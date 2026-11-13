/**
 * Pilot layer across the REAL physics-worker boundary: an NPC's control keys
 * are HELD between AI_INPUTS messages, like a pilot's INPUT (input queue rule
 * #3), so how hard an NPC flies does not depend on how often the room loop
 * gets to post.
 *
 * Filmed symptom (2026-11-13, showcase `npc-dogfight` 3v3 + `fleet-melee`
 * from fix/ai-dogfight-onsight, hostile review): "drones fly east side by
 * side at LOW speed ... robots barely move, drift ~30-40 px/s, tumbling a
 * little ... after the fight drones spin on the spot", while the in-process
 * integration test (`tests/integration/sectorRoom/dogfightOnSight.test.ts`)
 * reported a lively fight.
 *
 * Root cause: the worker applied each slot's AI keys on ONE physics step and
 * then dropped them. The room (main thread, setImmediate loop) and the worker
 * (its own 60 Hz timer) are not lock-stepped, so any step with no fresh
 * AI_INPUTS ran with no keys: no thrust, no brake, and a snap turn left
 * spinning at its last rate (angular damping 0 for most kinds). Measured on a
 * real dev server (perf-dogfight-3v3): 92 % of steps had keys on an idle box;
 * with the room loop loaded to ~32 Hz (EQX_PERF_BURN_MS=30) only 54 %, and
 * NPC turn rate fell 0.36 → 0.12 rad/s, speed 63 → 52 u/s. A pilot's held
 * input never had this coupling. The integration harness runs an idle room
 * loop, so it never showed it.
 *
 * This test spawns the production worker (bundleWorker, as SectorRoom does),
 * posts thrust keys at 20 Hz (a room loop slower than the worker), and
 * compares the NPC's speed with the same body thrusting every step in an
 * in-process PhysicsWorld over the same number of worker steps.
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
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGVEL_OFF,
} from '../../shared-types/sabLayout.js';
import { getShipKind, shipKindToIndex } from '../../shared-types/shipKinds.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import { AI_INPUT_THRUST, AI_INPUT_TURN_LEFT, decodeAiInputBits } from '../../core/contracts/IAiBehaviour.js';

const WORKER_TS = fileURLToPath(new URL('../../core/physics/worker.ts', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const FIGHTER = getShipKind('fighter');
const MASS = 16;

describe('physics worker — AI control keys are held between AI_INPUTS (real worker boundary)', () => {
  let worker: Worker;
  let u32: Uint32Array;
  let f32: Float32Array;
  const errors: Error[] = [];

  beforeAll(async () => {
    const code = await bundleWorker({ entryPoint: WORKER_TS, external: ['@dimforge/rapier2d-compat'] });
    const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
    u32 = new Uint32Array(sab);
    f32 = new Float32Array(sab);
    worker = new Worker(code, { eval: true, workerData: { sab } });
    worker.on('error', (e) => errors.push(e));
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

  async function readSlot(slot: number): Promise<{ vx: number; vy: number; angvel: number }> {
    const base = slotBase(slot);
    for (let i = 0; i < 1000; i++) {
      const s1 = Atomics.load(u32, SEQLOCK_IDX);
      if ((s1 & 1) === 0) {
        const vx = f32[base + SLOT_VX_OFF]!;
        const vy = f32[base + SLOT_VY_OFF]!;
        const angvel = f32[base + SLOT_ANGVEL_OFF]!;
        if (Atomics.load(u32, SEQLOCK_IDX) === s1) return { vx, vy, angvel };
      }
      await sleep(1);
    }
    throw new Error(`slot ${slot} never read cleanly`);
  }

  async function waitSlotOccupied(slot: number): Promise<void> {
    const deadline = Date.now() + 3000;
    while (u32[slotBase(slot) + SLOT_ID_OFF] !== slot + 1) {
      if (Date.now() > deadline) throw new Error(`slot ${slot} never occupied`);
      await sleep(5);
    }
  }

  /** Spawn an NPC fighter the way SwarmSpawner does (kind damping, ship kind). */
  function spawnNpc(slot: number, id: string, x: number): void {
    worker.postMessage({
      type: 'SPAWN_OBSTACLE', slot, obstacleId: id, x, y: 0, vx: 0, vy: 0,
      radius: FIGHTER.radius, mass: MASS, linearDamping: FIGHTER.linearDamping,
      shieldKindId: FIGHTER.id, shipKindId: shipKindToIndex(FIGHTER.id),
    });
  }

  function postKeys(slot: number, bits: number): void {
    worker.postMessage({ type: 'AI_INPUTS', count: 1, slots: Uint16Array.of(slot), bits: Uint8Array.of(bits) });
  }

  /** The same body thrusting on EVERY step for `steps` steps, in-process. */
  async function referenceSpeed(steps: number): Promise<number> {
    const w = await PhysicsWorld.create();
    w.spawnObstacle('ref', 0, 0, FIGHTER.radius, MASS, undefined, FIGHTER.linearDamping, undefined, undefined, FIGHTER);
    w.setPilotKind('ref', FIGHTER);
    const keys = { thrust: false, reverse: false, turnLeft: false, turnRight: false, boost: false };
    decodeAiInputBits(AI_INPUT_THRUST, keys);
    for (let i = 0; i < steps; i++) {
      w.applyAiInput('ref', keys);
      w.tick(1 / 60);
    }
    const s = w.getShipState('ref')!;
    return Math.hypot(s.vx, s.vy);
  }

  it('an NPC whose keys arrive at 20 Hz flies as hard as one keyed every step', async () => {
    spawnNpc(0, 'npc-a', 0);
    await waitSlotOccupied(0);
    const t0 = Atomics.load(u32, TICK_IDX);
    // A room loop slower than the worker: one AI_INPUTS every 50 ms.
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      postKeys(0, AI_INPUT_THRUST);
      await sleep(50);
    }
    const steps = Atomics.load(u32, TICK_IDX) - t0;
    const st = await readSlot(0);
    const speed = Math.hypot(st.vx, st.vy);
    const ref = await referenceSpeed(steps);
    console.log(`[ai-held] steps=${steps} worker speed=${speed.toFixed(1)} reference=${ref.toFixed(1)}`);
    expect(errors).toHaveLength(0);
    expect(ref).toBeGreaterThan(25);
    expect(speed).toBeGreaterThan(0.85 * ref);
    expect(speed).toBeLessThan(1.1 * ref);
  }, 20_000);

  it('a released turn stops the spin even if no further AI_INPUTS arrives late', async () => {
    spawnNpc(1, 'npc-b', 5000);
    await waitSlotOccupied(1);
    postKeys(1, AI_INPUT_TURN_LEFT);
    await sleep(100);
    expect(Math.abs((await readSlot(1)).angvel)).toBeGreaterThan(0.5);
    // Release: the next message carries no keys; the body must stop turning
    // and stay stopped (held "no keys", not a leftover snap rate).
    postKeys(1, 0);
    await sleep(200);
    expect(Math.abs((await readSlot(1)).angvel)).toBeLessThan(1e-3);
  }, 20_000);

  it('DESPAWN forgets the held keys (a reused slot starts with none)', async () => {
    spawnNpc(2, 'npc-c', 10_000);
    await waitSlotOccupied(2);
    postKeys(2, AI_INPUT_THRUST);
    await sleep(100);
    worker.postMessage({ type: 'DESPAWN', slot: 2, playerId: 'npc-c' });
    await sleep(50);
    spawnNpc(2, 'npc-d', 15_000);
    await waitSlotOccupied(2);
    await sleep(300);
    const st = await readSlot(2);
    expect(Math.hypot(st.vx, st.vy)).toBeLessThan(1e-3);
  }, 20_000);
});
