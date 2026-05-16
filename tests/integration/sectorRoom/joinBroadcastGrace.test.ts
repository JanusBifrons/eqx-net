/**
 * Regression lock — the user-reported "warp in → stay still → move →
 * teleport" bug. Reported repeatedly; root-caused 2026-05-15 from
 * diagnostic capture `2026-05-15T20-35-04-862Z-0ibj77`.
 *
 * THE BUG:
 *   A player who joins a quiet sector (initial join, inter-sector
 *   transit, or reconnect) spawns stationary. With no motion the
 *   sector idle-tracker never fires, so after `IDLE_THRESHOLD_TICKS`
 *   (60 ticks ≈ 1 s) the snapshot broadcast loop short-circuits
 *   entirely (Stage-5 idle suppression). The freshly-joined client
 *   then receives ZERO snapshots — its prediction world free-runs
 *   from a stale post-transit pose, the renderer shows the ship in
 *   the wrong place, and the instant the player provides a movement
 *   input the sector un-idles, the first snapshot lands, and the
 *   reconciler snaps the ship hundreds of units. The capture showed
 *   an 803-unit correction after a 5.25 s snapshot blackout.
 *
 * THE FIX:
 *   `SectorRoom` sets `forceBroadcastUntilTick = nowTick +
 *   JOIN_BROADCAST_GRACE_TICKS` on every join/spawn. While inside that
 *   window the broadcast gate ignores idle-suppression, guaranteeing
 *   the new client gets a steady snapshot stream long enough to
 *   reconcile. Once reconciled, a stationary ship's prediction matches
 *   the server so later idle-suppression is harmless.
 *
 * WHAT THIS TEST ASSERTS:
 *   A client joins and sends NO input (ship stays stationary, the
 *   exact condition that triggered the bug). We wait well past the
 *   1 s idle threshold and assert snapshots are STILL arriving. Before
 *   the fix this times out (broadcasts suppressed ~1 s after join);
 *   after the fix snapshots flow for the full grace window.
 *
 * WHY INTEGRATION: the bug lives at the server broadcast-loop / wire
 * seam, not in any single pure function. A unit test of the idle
 * tracker can't catch "a joined client received nothing" — only a
 * real client over a real socket can. See
 * `tests/integration/sectorRoom/DETERMINISM.md`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';

describe('SectorRoom — join-broadcast grace (no-input reconcile)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
    });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('keeps broadcasting snapshots to a stationary just-joined client past the idle threshold', async () => {
    const pid = randomUUID();
    const room = await harness.connectAs(pid, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });

    // Timestamp every snapshot relative to "now" (just after join).
    // Send NO input — the ship is stationary, the precise condition
    // that made the sector idle-suppress before the fix.
    const t0 = Date.now();
    const recv: Array<{ atMs: number; serverTick: number }> = [];
    room.onMessage('snapshot', (m: unknown) => {
      recv.push({ atMs: Date.now() - t0, serverTick: (m as SnapshotMessage).serverTick });
    });

    // Idle threshold is 60 ticks ≈ 1 s. Wait WELL past it. The grace
    // window is 5 s, so post-fix snapshots flow the whole time.
    await harness.advance(2500);

    // The discriminating assertion is TIME-BASED, not count-based: a
    // pre-fix server streams ~20 snapshots in the first ~1 s then
    // suppresses, so a raw `length > 10` would pass even broken. What
    // the bug actually breaks is the LATE part of the window — assert
    // snapshots arrived AFTER 1500 ms (well past the 1 s idle
    // threshold). Pre-fix that bucket is empty; post-fix it's a
    // healthy stream.
    const lateSnaps = recv.filter((r) => r.atMs >= 1500);
    expect(
      lateSnaps.length,
      `expected snapshots after 1500ms (post idle-threshold). recv timeline ms: ${recv.map((r) => r.atMs).join(', ')}`,
    ).toBeGreaterThan(5);

    // serverTick must advance across the late bucket — proves they're
    // fresh broadcasts, not a stale repeat.
    expect(
      lateSnaps[lateSnaps.length - 1]!.serverTick,
      'serverTick should keep advancing in the late window',
    ).toBeGreaterThan(lateSnaps[0]!.serverTick);
  }, 20_000);
});
