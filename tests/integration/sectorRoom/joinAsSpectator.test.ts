/**
 * Equinox Phase 5 (WS-3) — JOIN-AS-SPECTATOR. The galaxy "Spectate" CTA joins a
 * sector with `{ spectator: true }`: the player drops in as a free-roam camera
 * with NO ship at all — no `state.ships` entry, no slot, no roster row, no
 * lingering hull. Nothing in the world. They still receive snapshots (to watch
 * the sector) and can build structures.
 *
 * FAILING-FIRST (Invariant #9/#13): on the pre-WS-3 server the `spectator` join
 * option is ignored, so a hull SPAWNS and activates — the `spectator_join`
 * server event never fires (the `events.waitFor` times out) AND there is a ship
 * in `state.ships`. The fix spawns nothing, turning both locks GREEN. Reverting
 * the fix re-fails the test.
 *
 * Server-authoritative slice (the deterministic, race-free contract):
 *   1. A spectator join spawns NO ship (the `spectator_join` event fires; there
 *      is no `state.ships` entry for the player, no slot, no lingering hull).
 *   2. A NON-spectator control join still ACTIVATES a hull (the flag is opt-in).
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

  it('spectator join spawns NO ship — no hull, no slot, no lingering hull', async () => {
    const pid = randomUUID();

    const room = await harness.connectAs(pid, { spectator: true });
    room.send('client_ready', { type: 'client_ready' });

    // THE LOCK (race-free): the spectator path ran (no hull spawned). Absent on
    // pre-WS-3, where a hull would spawn + activate instead.
    await harness.events.waitFor(
      { tag: 'spectator_join', where: (d) => d['playerId'] === pid },
      5_000,
    );
    // Let the handshake drain (client_ready → warp_in → arrival) to be sure no
    // deferred activation sneaks a hull in.
    await harness.advance(900);

    const server = harness.getServerRoom()!;
    const state = server.state as SectorState;
    const internals = server._internals;

    // 1) NO ship of any kind for the spectator. Lingering hulls live in
    //    `state.ships` (isActive=false), so a zero count proves no active AND no
    //    lingering hull was created.
    let shipCount = 0;
    for (const [, s] of state.ships) {
      if (s.playerId === pid) shipCount++;
    }
    expect(shipCount, 'spectator must have NO ship in state.ships (active or lingering)').toBe(0);

    // Belt-and-suspenders: no lingering-slot entry maps to a pid-owned ship.
    let lingeringForPid = false;
    for (const [shipId] of internals.lingeringSlots) {
      const s = state.ships.get(shipId);
      if (s && s.playerId === pid) lingeringForPid = true;
    }
    expect(lingeringForPid, 'spectator left NO lingering hull').toBe(false);

    await harness.disconnectClient(room);
  }, 30_000);

  it('a NON-spectator join still ACTIVATES a hull — the flag is opt-in, not a regression', async () => {
    const pid = randomUUID();
    const room = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const server = harness.getServerRoom()!;
    const state = server.state as SectorState;
    let active = false;
    for (const [, s] of state.ships) {
      if (s.playerId === pid && s.isActive) { active = true; break; }
    }
    expect(active, 'a normal (non-spectator) join activates a hull').toBe(true);
    await harness.disconnectClient(room);
  }, 30_000);
});
