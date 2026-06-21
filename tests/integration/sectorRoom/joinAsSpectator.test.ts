/**
 * Equinox Phase 5 (WS-3) — JOIN-AS-SPECTATOR. The galaxy "Join as spectator"
 * CTA joins a sector with `{ spectator: true }`: the server spawns the hull
 * through the normal join handshake (so the client's join-readiness lifts the
 * load curtain the proven way), then PARKS it as a lingering hull at the
 * arrival flip instead of activating it. The player arrives with NO active hull
 * (free-roam spectator); the parked hull is theirs to pilot later via the
 * in-world Pilot dropdown (WS-A2 `pilot_ship`).
 *
 * FAILING-FIRST (Invariant #9/#13): on the pre-WS-3 server the `spectator` join
 * option is ignored, so the hull ACTIVATES normally — the `spectator_join_parked`
 * server event never fires (the `events.waitFor` times out) AND the player has
 * an ACTIVE hull, so both locks below are RED. The fix parks the hull, turning
 * them GREEN. Reverting the fix re-fails the test.
 *
 * Server-authoritative slice (the deterministic, race-free contract):
 *   1. A spectator join PARKS the hull (the `spectator_join_parked` event fires).
 *   2. The player has NO active hull after the handshake completes.
 *   3. A LINGERING hull for the player exists (in `lingeringSlots`, `isActive=false`).
 *   4. A NON-spectator control join still ACTIVATES (the flag is opt-in, not a
 *      regression of the normal path).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

describe('SectorRoom integration — WS-3 join-as-spectator', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('spectator join PARKS the hull — no active hull, a lingering hull instead', async () => {
    const pid = randomUUID();

    // Join as a spectator + complete the handshake. The hull spawns invisibly,
    // then PARKS at the arrival flip (≥ ARRIVAL_OFFSET_TICKS after client_ready).
    const room = await harness.connectAs(pid, { spectator: true, shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    room.send('client_ready', { type: 'client_ready' });

    // THE LOCK (race-free): the spectator-park path ran. Absent on pre-WS-3.
    await harness.events.waitFor(
      { tag: 'spectator_join_parked', where: (d) => d['playerId'] === pid },
      5_000,
    );

    const server = harness.getServerRoom()!;
    const state = server.state as SectorState;
    const internals = server._internals;

    // 2) The player has NO active hull.
    let activeCount = 0;
    let parkedShipId = '';
    for (const [, s] of state.ships) {
      if (s.playerId !== pid) continue;
      if (s.isActive) activeCount++;
      else parkedShipId = s.shipInstanceId;
    }
    expect(activeCount, 'spectator must have NO active hull').toBe(0);

    // 3) A lingering hull for the player exists, parked + owned.
    expect(parkedShipId, 'spectator should leave a parked (lingering) hull').not.toBe('');
    expect(internals.lingeringSlots.has(parkedShipId), 'parked hull is in lingeringSlots').toBe(true);
    const parked = state.ships.get(parkedShipId)!;
    expect(parked.playerId).toBe(pid);
    expect(parked.isActive).toBe(false);
    expect(parked.alive).toBe(true);

    await harness.disconnectClient(room);
  }, 30_000);

  it('a NON-spectator join still ACTIVATES — the flag is opt-in, not a regression', async () => {
    const pid = randomUUID();
    // connectActive polls until isActive — a normal join must still go active.
    const room = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const server = harness.getServerRoom()!;
    const state = server.state as SectorState;
    let active = false;
    for (const [, s] of state.ships) {
      if (s.playerId === pid && s.isActive) { active = true; break; }
    }
    expect(active, 'a normal (non-spectator) join activates the hull').toBe(true);
    await harness.disconnectClient(room);
  }, 30_000);
});
