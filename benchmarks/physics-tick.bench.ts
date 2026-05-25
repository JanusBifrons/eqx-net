/**
 * Phase 2 benchmarks — physics tick cost and SAB read/write overhead.
 *
 * Run: pnpm bench
 *
 * Acceptance criterion: SAB write + SAB read overhead ≤ 5 % of tick cost
 * at 500 entities, confirming the worker path adds negligible latency vs
 * the Phase 1 main-thread approach.
 */
import { bench, describe } from 'vitest';
import { PhysicsWorld } from '../src/core/physics/World.js';
import {
  SEQLOCK_IDX,
  SLOT_ID_OFF,
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGLE_OFF,
  slotBase,
  SAB_TOTAL_BYTES,
} from '../src/shared-types/sabLayout.js';

// ── helpers ────────────────────────────────────────────────────────────────

function writeSAB(
  u32: Uint32Array,
  f32: Float32Array,
  states: Map<string, { x: number; y: number; vx: number; vy: number; angle: number }>,
  playerToSlot: Map<string, number>,
): void {
  Atomics.add(u32, SEQLOCK_IDX, 1); // lock
  for (const [id, s] of states) {
    const slot = playerToSlot.get(id);
    if (slot === undefined) continue;
    const base = slotBase(slot);
    u32[base + SLOT_ID_OFF] = slot + 1;
    f32[base + SLOT_X_OFF]  = s.x;
    f32[base + SLOT_Y_OFF]  = s.y;
    f32[base + SLOT_VX_OFF] = s.vx;
    f32[base + SLOT_VY_OFF] = s.vy;
    f32[base + SLOT_ANGLE_OFF] = s.angle;
  }
  Atomics.add(u32, SEQLOCK_IDX, 1); // unlock
}

function readSAB(u32: Uint32Array, f32: Float32Array, slots: number[]): void {
  for (;;) {
    const seq1 = Atomics.load(u32, SEQLOCK_IDX);
    if (seq1 & 1) continue;
    for (const slot of slots) {
      const base = slotBase(slot);
      // Read each field into a local (discarded) — measures memory access cost.
      void f32[base + SLOT_X_OFF];
      void f32[base + SLOT_Y_OFF];
      void f32[base + SLOT_VX_OFF];
      void f32[base + SLOT_VY_OFF];
      void f32[base + SLOT_ANGLE_OFF];
    }
    const seq2 = Atomics.load(u32, SEQLOCK_IDX);
    if (seq1 === seq2) break;
  }
}

// ── benchmark suites ───────────────────────────────────────────────────────

for (const N of [100, 500, 1000]) {
  describe(`${N} entities`, () => {
    // `beforeAll` does NOT run in vitest 2.1.x bench mode (samples drop
    // to 0). Per-bench `setup` is the supported alternative. Each setup
    // builds a fresh world / SAB; the closure-captured refs are
    // initialised once per bench before its sampling window.
    let world: PhysicsWorld;
    let playerToSlot: Map<string, number> = new Map();
    let slots: number[] = [];
    let u32: Uint32Array;
    let f32: Float32Array;

    const setup = async (): Promise<void> => {
      world = await PhysicsWorld.create();
      playerToSlot = new Map();
      slots = [];
      for (let i = 0; i < N; i++) {
        const id = `entity-${i}`;
        world.spawnShip(id, (Math.random() - 0.5) * 2000, (Math.random() - 0.5) * 2000);
        playerToSlot.set(id, i);
        slots.push(i);
      }

      const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
      u32 = new Uint32Array(sab);
      f32 = new Float32Array(sab);
    };

    bench(
      'physics tick (main thread)',
      () => {
        world.tick(1 / 60);
      },
      { setup },
    );

    bench(
      'SAB write — seqlock + N entity states',
      () => {
        writeSAB(u32, f32, world.getAllShipStates(), playerToSlot);
      },
      { setup },
    );

    bench(
      'SAB read — seqlock + N entity states',
      () => {
        readSAB(u32, f32, slots);
      },
      { setup },
    );
  });
}
