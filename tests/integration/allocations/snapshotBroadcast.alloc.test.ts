/**
 * Allocation regression lock for the server snapshot broadcast path
 * (Phase 1 of the 2026-05-25 GC sweep).
 *
 * The `SectorRoom.update()` broadcast block (lines ~3880-4180) previously
 * allocated:
 *   - `allShips: AllShipEntry[]` + per-ship `{ ..., lastInput: {...} }` literal
 *   - `boostingIds`, `thrustingIds`, `sharedTail`
 *   - Per-recipient `states: {}`, `projectiles: []`, `drones: []`, `wrecks: []`
 *   - Per-ship `mountAnglesArr = new Array(...)`
 *   - Per-recipient `snap: SnapshotMessage = { ... }` envelope
 *
 * All now consume `SnapshotScratch`. This test drives the broadcast loop
 * many times and asserts each pool's `allocations()` counter is bounded
 * by the peak-concurrent cardinality, NOT by the broadcast count.
 *
 * Modelled on `src/core/combat/HitPrediction.test.ts:229` — the canonical
 * project pattern. See [docs/architecture/gc-discipline.md].
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from '../sectorRoom/harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';

// Cross the private boundary deliberately — the regression probe lives
// on the pools' `allocations()` counter, which is internal to
// `SnapshotScratch`. This test exists to prevent silent regressions.
interface RoomWithScratch {
  snapshotScratch: {
    allShipsPool: { allocations(): number };
    stateEntryPool: { allocations(): number };
    projectileEntryPool: { allocations(): number };
    droneEntryPool: { allocations(): number };
    wreckEntryPool: { allocations(): number };
    mountAngleArrays: Map<string, number[]>;
  };
}

describe('SectorRoom snapshot broadcast — allocation regression', () => {
  let harness: SectorTestHarness | null = null;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
  });

  it('steady-state broadcast does not grow pools past peak cardinality', async () => {
    harness = await bootSectorTestServer({ droneCount: 0 });
    // Three players in one sector — enough to exercise the per-recipient
    // states map and the boosting/thrusting filter without flooding the
    // test's wall-clock budget.
    const r1 = await harness.connectAs('alloc-player-1');
    const r2 = await harness.connectAs('alloc-player-2');
    const r3 = await harness.connectAs('alloc-player-3');

    // Unidle the sector so the broadcast loop actually runs.
    harness.sendThrust(r1);

    // Capture snapshots so we can assert wire-shape correctness post-pool.
    const snapsR1: SnapshotMessage[] = [];
    r1.onMessage('snapshot', (s: SnapshotMessage) => snapsR1.push(s));

    // Let the broadcast loop run for ~1.5 s (≥30 snapshots at 20 Hz × 3 recipients).
    await harness.advance(1500);

    const room = harness.getServerRoom() as unknown as SectorRoom & RoomWithScratch;
    expect(room).not.toBeNull();

    const SHIPS = 3;
    const CLIENTS = 3;

    // ── Pool bounds — parameterised by peak cardinality, NOT broadcast count ──
    //
    // `allShipsPool` builds the shared digest once per tick. Peak concurrent
    // entries == ship count. The +2 is slack for warmup / one transient
    // overflow on shutdown sequencing.
    const allShipAllocs = room.snapshotScratch.allShipsPool.allocations();
    expect(allShipAllocs).toBeLessThanOrEqual(SHIPS + 2);

    // `stateEntryPool` reuses entries across recipients within a tick: peak
    // concurrent ≤ SHIPS (one tick fills the map; next-recipient resets it).
    const stateAllocs = room.snapshotScratch.stateEntryPool.allocations();
    expect(stateAllocs).toBeLessThanOrEqual(SHIPS + 2);

    // No projectiles fired, no drones in interest, no wrecks — these pools
    // should not have allocated at all in steady state.
    expect(room.snapshotScratch.projectileEntryPool.allocations()).toBe(0);
    expect(room.snapshotScratch.droneEntryPool.allocations()).toBe(0);
    expect(room.snapshotScratch.wreckEntryPool.allocations()).toBe(0);

    // Wire shape sanity — every snapshot received was well-formed JSON
    // with the expected fields. This is a smoke check; full wire equivalence
    // is a separate test.
    expect(snapsR1.length).toBeGreaterThan(5);
    for (const snap of snapsR1) {
      expect(snap.type).toBe('snapshot');
      expect(typeof snap.serverTick).toBe('number');
      expect(typeof snap.states).toBe('object');
      // No empty-collection fields leaked onto the wire (msgpack should
      // drop missing keys — verified by absence in the parsed message).
      expect(snap.projectiles).toBeUndefined();
      expect(snap.drones).toBeUndefined();
      expect(snap.wrecks).toBeUndefined();
    }

    // Keep `CLIENTS` referenced so future maintainers see it scales with recipients.
    void CLIENTS; void r2; void r3;
  }, 30_000);

  it('repeated broadcasts do not grow allocations linearly', async () => {
    harness = await bootSectorTestServer({ droneCount: 0 });
    const r1 = await harness.connectAs('alloc-soak-1');
    harness.sendThrust(r1);

    // Warm up
    await harness.advance(500);
    const room = harness.getServerRoom() as unknown as SectorRoom & RoomWithScratch;
    const warmAllocs = room.snapshotScratch.stateEntryPool.allocations();

    // Let it run substantially longer
    await harness.advance(1500);
    const afterAllocs = room.snapshotScratch.stateEntryPool.allocations();

    // Allocations should NOT increase by more than a small slack — proving
    // the pool is genuinely reused across many ticks.
    expect(afterAllocs - warmAllocs).toBeLessThanOrEqual(2);
  }, 30_000);
});
