/**
 * Phase 5e — swarm broadcast encoder benchmark.
 *
 * Run: pnpm bench
 *
 * Acceptance: encoding 500 entities × 4 clients per server tick stays
 * under 2.5 ms total (≈ 15% of one core's 16.67 ms tick budget at 60 Hz).
 * Hot path is expected to do zero allocation — we exercise it for many
 * iterations so any per-call alloc would surface as a heap-growth signal
 * (vitest-bench surfaces ms; we just measure cost here, not heap delta).
 */
// vitest 2.x bench mode does NOT run `beforeAll` — setup is at module
// load (this one is sync, so no top-level await needed). Measured
// `bench()` bodies unchanged. Guarded by
// `scripts/check-bench-samples.mjs`. See docs/LESSONS.md 2026-05-19.
import { bench, describe } from 'vitest';
import { BinarySwarmBroadcast } from '../src/server/net/BinarySwarmBroadcast.js';
import { SwarmEntityRegistry } from '../src/server/net/SwarmEntityRegistry.js';
import { SpatialGrid } from '../src/server/interest/SpatialGrid.js';
import {
  SAB_TOTAL_BYTES,
  slotBase,
  SLOT_X_OFF, SLOT_Y_OFF, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_ANGLE_OFF,
} from '../src/shared-types/sabLayout.js';

const ENTITY_COUNT = 500;
const CLIENT_COUNT = 4;
const WORLD_RADIUS = 18_000;

const registry = new SwarmEntityRegistry();
const encoder = new BinarySwarmBroadcast();
const grid = new SpatialGrid();
const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
const f32 = new Float32Array(sab);
const u32 = new Uint32Array(sab);
/** Per-client (cx, cy) cell coordinates the encoder filters against. */
const clientCells: Array<{ cx: number; cy: number }> = [];
/** Pre-allocated scratch sets so query9 doesn't allocate per call. */
const scratchSets: Array<Set<number>> = [];
let serverTick = 0;

{
  // Sunflower-spiral spread mirroring SwarmSpawner.seed.
  const PHI = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < ENTITY_COUNT; i++) {
    const t = (i + 0.5) / ENTITY_COUNT;
    const r = Math.sqrt(t) * WORLD_RADIUS;
    const angle = i * PHI;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    const slot = i;
    const rec = registry.register(`e-${i}`, slot, i % 5 === 0 ? 1 : 0, 24, x, y, 0);
    const b = slotBase(slot);
    f32[b + SLOT_X_OFF] = x;
    f32[b + SLOT_Y_OFF] = y;
    f32[b + SLOT_VX_OFF] = Math.cos(angle * 1.7) * 0.5;
    f32[b + SLOT_VY_OFF] = Math.sin(angle * 1.7) * 0.5;
    f32[b + SLOT_ANGLE_OFF] = 0;
    grid.insert(rec.entityId, x, y);
  }

  // Spread clients evenly across the disc so their interest windows don't
  // overlap entirely (worst case for the encoder is non-overlapping windows
  // — each entity ships to many clients).
  for (let c = 0; c < CLIENT_COUNT; c++) {
    const angle = (c / CLIENT_COUNT) * Math.PI * 2;
    const r = WORLD_RADIUS * 0.5;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    clientCells.push(grid.cellOf(x, y));
    scratchSets.push(new Set<number>());
  }
}

describe('swarm broadcast — 500 entities × 4 clients', () => {
  bench('encode for 4 clients (per server tick)', () => {
    serverTick = (serverTick + 1) >>> 0;
    for (let c = 0; c < CLIENT_COUNT; c++) {
      const { cx, cy } = clientCells[c]!;
      const scratch = scratchSets[c]!;
      grid.query9(cx, cy, scratch);
      encoder.encode(registry, f32, u32, serverTick, scratch);
    }
  });

  bench('encode broadcast-all (no filter, baseline)', () => {
    serverTick = (serverTick + 1) >>> 0;
    for (let c = 0; c < CLIENT_COUNT; c++) {
      encoder.encode(registry, f32, u32, serverTick);
    }
  });

  bench('grid.query9 only (4 clients)', () => {
    for (let c = 0; c < CLIENT_COUNT; c++) {
      const { cx, cy } = clientCells[c]!;
      grid.query9(cx, cy, scratchSets[c]!);
    }
  });
});
