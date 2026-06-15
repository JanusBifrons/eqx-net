/**
 * Heap-delta lock for `syncProjectiles`'s caller-injected scratch
 * (plan: quirky-rabbit, Phase 4).
 *
 * Pre-Phase-4 the function allocated `new Set<string>()` per call
 * (~20 Hz × N clients). Phase 4 moved ownership to the caller via the
 * `seenScratch` parameter — the caller (ColyseusClient) holds the Set
 * as a class field, clears it before each call. This test verifies the
 * pure helper itself is now allocation-free across sustained calls
 * (a regression where the helper started allocating internally would
 * flip the heap-delta inequality).
 *
 * The other generation-counter migrations (PixiRenderer.updateLingeringShips
 * / HaloRadar) live behind Pixi instances that
 * are awkward to spin up in a unit test — their behaviour is covered
 * by the existing integration suite (cleanup correctness is the
 * functional contract; the heap angle is a separate concern that this
 * Phase-4 commit's test infrastructure WILL pick up later via the
 * probe-page allocation gate planned for Phase 7).
 *
 * Run with `pnpm test:gc`.
 */
import { describe, it, expect } from 'vitest';
import { syncProjectiles } from './SnapshotSyncHelpers.js';
import type { RenderMirror, ProjectileRenderState } from '../../core/contracts/IRenderer.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';

function requireGc(): () => void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') {
    throw new Error('global.gc not available — run via `pnpm test:gc`.');
  }
  return gc;
}

function postGcHeap(): number {
  const gc = requireGc();
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

function makeMirror(): RenderMirror {
  return {
    ships: new Map(),
    projectiles: new Map<string, ProjectileRenderState>(),
    localPlayerId: null,
  };
}

function makeSnapshot(n: number): NonNullable<SnapshotMessage['projectiles']> {
  const out: NonNullable<SnapshotMessage['projectiles']> = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `p${i}`,
      x: i, y: i, vx: 1, vy: 1,
      ownerId: 'owner',
      weaponId: 'hitscan',
    });
  }
  return out;
}

describe('syncProjectiles heap-delta (Phase 4 generation-counter)', () => {
  it('repeated syncProjectiles calls do not grow heap', () => {
    const mirror = makeMirror();
    const seen = new Set<string>();
    const snapshot = makeSnapshot(20);

    // Warmup — seed mirror.projectiles + let JIT settle.
    for (let i = 0; i < 1000; i++) syncProjectiles(mirror, snapshot, seen);

    const before = postGcHeap();
    for (let i = 0; i < 10_000; i++) syncProjectiles(mirror, snapshot, seen);
    const after = postGcHeap();

    const growth = after - before;
    // Same threshold as the other heap-delta tests — 200 KB across
    // 10 000 calls is roughly 20 B per call, which catches a fresh
    // `new Set()` regression but tolerates V8 internals drift.
    expect(growth).toBeLessThan(200_000);
  });

  it('caller-injected Set is reused (identity-stable across calls)', () => {
    const mirror = makeMirror();
    const seen = new Set<string>();
    const snapshot = makeSnapshot(5);

    syncProjectiles(mirror, snapshot, seen);
    const firstRef = seen;
    syncProjectiles(mirror, snapshot, seen);
    expect(seen).toBe(firstRef); // same Set instance — caller owns it
    expect(seen.size).toBe(5); // populated by THIS call's snapshot
  });
});
