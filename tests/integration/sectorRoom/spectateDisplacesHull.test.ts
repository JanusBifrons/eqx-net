/**
 * Equinox Phase-5 audit (2026-06-21) — the DEAD PILOT DROPDOWN. On-device:
 * "When I click Pilot it says 'no ships to pilot'… I literally just spawned one"
 * and "I can't select the ship I just left."
 *
 * Root cause: toggling Spectate was a pure CLIENT flip (`pilotMode='spectator'`).
 * The active hull stayed `isActive=true` on the server, so it lived in
 * `mirror.ships` (active), NEVER `mirror.lingeringShips` — and the in-world Pilot
 * dropdown lists ONLY lingering hulls. So the dropdown was always empty.
 *
 * Fix: the Spectate toggle now sends `spectate`, and the server DISPLACES the
 * caller's active hull into a lingering hull (the inverse of `pilot_ship`). The
 * just-left ship then parks in-world AND surfaces in the player's own
 * `lingeringShips` → the dropdown lists it → `pilot_ship` re-boards it.
 *
 * Failing-first (Invariant #13): on pre-fix code there is no `spectate` handler,
 * so the hull stays ACTIVE and is never in `lingeringSlots` — this test's
 * assertions fail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

describe('SectorRoom integration — spectate displaces the active hull to lingering', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('spectate parks the active hull as a LINGERING hull the owner can pilot', async () => {
    const pid = randomUUID();
    const client = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;
    const internals = room._internals;

    // Precondition: an ACTIVE hull, NOT yet lingering.
    let shipId = '';
    for (const [, s] of state.ships) {
      if (s.playerId === pid && s.isActive) { shipId = s.shipInstanceId; break; }
    }
    expect(shipId).not.toBe('');
    expect(internals.lingeringSlots.has(shipId)).toBe(false);

    // Toggle Spectate → the displace message.
    client.send('spectate', { type: 'spectate' });
    await harness.advance(300);

    // THE LOCK: the hull is now a LINGERING hull (parked), owned by the player,
    // and the player has NO active hull. This is exactly what the Pilot dropdown
    // (mirror.lingeringShips filtered by ownerPlayerId) needs to list it.
    expect(internals.lingeringSlots.has(shipId), 'just-left hull is now a lingering slot').toBe(true);
    const ship = state.ships.get(shipId)!;
    expect(ship.playerId).toBe(pid);
    expect(ship.isActive, 'the displaced hull is no longer active').toBe(false);
    expect(ship.alive).toBe(true);
    let activeCount = 0;
    for (const [, s] of state.ships) {
      if (s.playerId === pid && s.isActive) activeCount++;
    }
    expect(activeCount, 'player has no active hull after spectate').toBe(0);
    // The roster row survives (owned) so a later pilot_ship can reclaim it.
    const rec = getPlayerShipStore().get(shipId);
    expect(rec).not.toBeNull();
    expect(rec!.playerId).toBe(pid);

    await harness.disconnectClient(client);
  }, 30_000);

  it('spectate is a SILENT no-op when the player has no active hull', async () => {
    // A spectator-join (no hull) sending spectate must not throw / mutate state.
    const pid = randomUUID();
    const room = (await bootSpectatorless(harness, pid));
    // The connectAs client has no active hull; spectate is harmless.
    room.client.send('spectate', { type: 'spectate' });
    await harness.advance(200);
    const state = harness.getServerRoom()!.state as SectorState;
    let count = 0;
    for (const [, s] of state.ships) if (s.playerId === pid) count++;
    expect(count).toBe(0); // still no ship — no crash, no phantom
    await harness.disconnectClient(room.client);
  }, 30_000);
});

/** Join a spectator (no active hull) so we can exercise the no-op spectate path. */
async function bootSpectatorless(
  harness: SectorTestHarness,
  pid: string,
): Promise<{ client: Awaited<ReturnType<SectorTestHarness['connectAs']>> }> {
  const client = await harness.connectAs(pid, { spectator: true });
  client.send('client_ready', { type: 'client_ready' });
  await harness.events.waitFor({ tag: 'spectator_join', where: (d) => d['playerId'] === pid }, 5_000);
  return { client };
}
