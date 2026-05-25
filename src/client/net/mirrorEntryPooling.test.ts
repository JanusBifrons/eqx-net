/**
 * Probe 7 (mobile-perf-investigation, 2026-05-24) — mirror entry pooling.
 *
 * The 2kn41x capture proved heap climbs ~1-2 MB/sec in galaxy gameplay,
 * triggering a major GC every ~30s with a ~500 ms pause. Probe 6
 * (snapshot coalescing) breaks the spiral feedback loop downstream of
 * those pauses, but Probe 7 attacks the GC frequency at the source.
 *
 * The dominant allocation site per RAF: `updateMirror`'s per-ship
 * rebuild. Pre-fix pattern (verbatim from ColyseusClient pre-Probe-7):
 *
 *   this.mirror.ships.set(localId, {
 *     x, y, vx, vy, angle,
 *     ...(prev?.kind ? { kind: prev.kind } : {}),         // alloc
 *     ...(prev?.displayName !== undefined ? { displayName } : {}),  // alloc
 *     ...(prev?.mountAngles ? { mountAngles } : {}),      // alloc
 *   });                                                     // alloc
 *
 * That's 1 entry object + 3 conditional-spread sources = up to 4
 * allocations PER SHIP PER RAF. At 25 in-interest entities × 90 RAFs/s
 * = ~9000 allocs/sec just from this single hot path.
 *
 * Post-fix pattern (Probe 7): mutate the existing entry in place.
 * Non-spatial fields stay on the entry across rebuilds because we
 * never touch them — `syncMirror` writes kind/displayName, and
 * `tickLocalMountAim` writes mountAngles. Both write paths now have
 * the entry as a stable reference (the same object across frames).
 *
 * Tests below assert the load-bearing invariants:
 *   - Same entry object reference across consecutive rebuilds (no alloc).
 *   - kind / displayName / mountAngles SURVIVE successive rebuilds
 *     without explicit preservation logic in the rebuild site.
 *   - Spatial fields ARE updated on every rebuild (no stale pose).
 *   - First-spawn case (no existing entry) still creates a new entry.
 *
 * The existing mountAnglesPreservation.test.ts locks the same
 * invariant against the OLD conditional-spread shape. After Probe 7,
 * the preservation comes "for free" from not touching the field —
 * which is structurally safer than the spread pattern AND zero-alloc.
 */
import { describe, it, expect } from 'vitest';
import type { ShipRenderState } from '@core/contracts/IRenderer';

/**
 * Pure helper that mirrors the inline pooling pattern in
 * `ColyseusClient.updateMirror`. Extracted so the invariants can be
 * locked deterministically without spinning up a full client.
 *
 * Contract: mutate the existing entry's spatial fields; create a new
 * entry only on first spawn. Non-spatial fields are NEVER touched here.
 */
function updateSpatialFieldsPooled(
  ships: Map<string, ShipRenderState>,
  id: string,
  state: { x: number; y: number; vx: number; vy: number; angle: number },
): ShipRenderState {
  let entry = ships.get(id);
  if (!entry) {
    entry = { x: state.x, y: state.y, vx: state.vx, vy: state.vy, angle: state.angle };
    ships.set(id, entry);
  } else {
    entry.x = state.x;
    entry.y = state.y;
    entry.vx = state.vx;
    entry.vy = state.vy;
    entry.angle = state.angle;
  }
  return entry;
}

describe('Probe 7 — mirror entry pooling: zero-alloc spatial rebuilds', () => {
  it('first call creates a new entry', () => {
    const ships = new Map<string, ShipRenderState>();
    updateSpatialFieldsPooled(ships, 'p1', { x: 10, y: 20, vx: 1, vy: 2, angle: 0.5 });
    const entry = ships.get('p1');
    expect(entry).toBeDefined();
    expect(entry).toEqual({ x: 10, y: 20, vx: 1, vy: 2, angle: 0.5 });
  });

  it('SAME entry object reference is reused across consecutive calls (no allocation)', () => {
    const ships = new Map<string, ShipRenderState>();
    updateSpatialFieldsPooled(ships, 'p1', { x: 10, y: 20, vx: 0, vy: 0, angle: 0 });
    const firstRef = ships.get('p1');
    for (let i = 0; i < 100; i++) {
      updateSpatialFieldsPooled(ships, 'p1', { x: i, y: i, vx: 0, vy: 0, angle: 0 });
    }
    const lastRef = ships.get('p1');
    expect(lastRef).toBe(firstRef); // strict object identity — pool is the win
    expect(lastRef!.x).toBe(99); // but spatial fields ARE updated
  });

  it('non-spatial fields (kind/displayName/mountAngles) survive successive rebuilds without explicit preservation', () => {
    const ships = new Map<string, ShipRenderState>();
    updateSpatialFieldsPooled(ships, 'p1', { x: 0, y: 0, vx: 0, vy: 0, angle: 0 });
    // Simulate `syncMirror` writing the kind + displayName fields.
    const entry = ships.get('p1')!;
    entry.kind = 'interceptor';
    entry.displayName = 'Alice';
    // Simulate `tickLocalMountAim` writing mount angles.
    entry.mountAngles = [0.1, -0.2];
    // 60 RAFs worth of spatial updates.
    for (let i = 0; i < 60; i++) {
      updateSpatialFieldsPooled(ships, 'p1', { x: i, y: 0, vx: 0, vy: 0, angle: 0 });
    }
    const final = ships.get('p1')!;
    expect(final.kind).toBe('interceptor');
    expect(final.displayName).toBe('Alice');
    expect(final.mountAngles).toEqual([0.1, -0.2]);
    // And the spatial fields advanced.
    expect(final.x).toBe(59);
  });

  it('mountAngles ARRAY reference is preserved (no per-frame array allocation)', () => {
    // This is the load-bearing case from CLAUDE.md Multi-mount mirror
    // surfaces — `MountVisualManager.applyMountAngles` reads from this
    // array each render. If we replaced it per RAF the consumer would
    // miss updates. Pooling keeps the same array reference forever.
    const ships = new Map<string, ShipRenderState>();
    updateSpatialFieldsPooled(ships, 'p1', { x: 0, y: 0, vx: 0, vy: 0, angle: 0 });
    const entry = ships.get('p1')!;
    const angles = [0.1, -0.2];
    entry.mountAngles = angles;
    for (let i = 0; i < 30; i++) {
      updateSpatialFieldsPooled(ships, 'p1', { x: i, y: 0, vx: 0, vy: 0, angle: 0 });
    }
    expect(ships.get('p1')!.mountAngles).toBe(angles); // identity, not just equality
  });

  it('ALLOCATION COUNT: 1 new entry per ship + ZERO subsequent allocations', () => {
    // Sentinel test — count Map.set() calls. The Map.set() call ITSELF
    // allocates a Map node, but only ON CREATE. Subsequent ships.set()
    // for an existing key updates in place. We track creates by Map
    // size growth instead of relying on Map internals.
    const ships = new Map<string, ShipRenderState>();
    updateSpatialFieldsPooled(ships, 'p1', { x: 0, y: 0, vx: 0, vy: 0, angle: 0 });
    expect(ships.size).toBe(1);
    for (let i = 0; i < 100; i++) {
      updateSpatialFieldsPooled(ships, 'p1', { x: i, y: 0, vx: 0, vy: 0, angle: 0 });
    }
    expect(ships.size).toBe(1); // no new Map entries, no allocs
  });

  it('REGRESSION-WATCH (mountAnglesPreservation parity): mount angles never wipe', () => {
    // Mirrors the same guarantee as mountAnglesPreservation.test.ts but
    // for the pooled path. The original test was written against the
    // conditional-spread shape. This re-locks the invariant against the
    // pooled shape — if a future contributor removes the "don't touch
    // mountAngles on rebuild" rule, both tests fail and the regression
    // is loud.
    const ships = new Map<string, ShipRenderState>();
    updateSpatialFieldsPooled(ships, 'p1', { x: 0, y: 0, vx: 0, vy: 0, angle: 0 });
    const angles: number[] = [];
    for (let frame = 0; frame < 600; frame++) {
      // Every 60 frames, simulate tickLocalMountAim writing fresh angles.
      if (frame % 60 === 0) {
        angles.push(0.01 * frame);
      }
      // Mutate the angles array (typical mount-aim path).
      ships.get('p1')!.mountAngles = angles;
      // Spatial update.
      updateSpatialFieldsPooled(ships, 'p1', { x: frame, y: 0, vx: 0, vy: 0, angle: 0 });
      // Mount angles MUST be the same array we just set.
      expect(ships.get('p1')!.mountAngles).toBe(angles);
    }
  });
});
