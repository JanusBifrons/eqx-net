/**
 * Campaign PR 3.1 (anti-patterns review 2026-07, A14 / Part D #2 — the
 * server-authoritative slice) — failing-first lock for the DEAD-PLAYER WARP.
 *
 * Playtest ("Equinox Tweaks" Phase 6): "After being destroyed it allows me
 * to click 'warp here' and actually started warping! I'm dead!!! How can I
 * warp?" Root cause: `TransitOrchestrator.beginTransit` validates the
 * source sector, neighbourhood, in-flight dedup, and roster ownership — but
 * never that the requester HAS a live, active hull. The SHIP_DESTROYED
 * abort only covers death DURING the spool; a player who was already dead
 * (spectating) sailed straight through and the server spooled a warp for a
 * hull that doesn't exist.
 *
 * Contract locked here: an `engage_transit` from a dead player is rejected
 * (DOCKED, never SPOOLING). RED pre-fix: the server answers SPOOLING.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

describe('SectorRoom integration — a DEAD player cannot engage transit (campaign 3.1)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('engage_transit after local death answers DOCKED, never SPOOLING', { timeout: 15_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { shipKind: 'scout' });
    const room = matchMaker.getLocalRoomById(cr.roomId) as unknown as SectorRoom;
    const state = room.state as SectorState;
    const ship = [...state.ships.values()][0]!;

    const states: string[] = [];
    cr.onMessage('transit_state', (msg: { state: string }) => states.push(msg.state));

    // Kill the hull through the real damage choke point (hull + shield),
    // then poll the schema until the death lands (alive=false or entry gone).
    const internal = (room as unknown as { _internals: { applyDamage(t: string, s: string, d: number): void } })._internals;
    // Layered damage is no-spillover: the shield-breaking hit is fully
    // absorbed, so a kill takes one shield-break + one lethal hull hit.
    internal.applyDamage(pid, 'attacker', ship.shield + 1_000);
    internal.applyDamage(pid, 'attacker', ship.health + 1_000);
    const killDeadline = Date.now() + 3_000;
    while (Date.now() < killDeadline) {
      const s = [...state.ships.values()].find((sh) => sh.playerId === pid);
      if (!s || !s.alive || !s.isActive) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const postKill = [...state.ships.values()].find((sh) => sh.playerId === pid);
    expect(postKill === undefined || !postKill.alive || !postKill.isActive).toBe(true);

    // The dead player asks to warp to a real neighbour.
    cr.send('engage_transit', { type: 'engage_transit', targetSectorKey: 'vega-reach' });

    // Wait for the server's answer.
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline && states.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(states.length, 'server sent no transit_state answer at all').toBeGreaterThan(0);
    expect(
      states[0],
      'a DEAD player was allowed to start spooling a warp — beginTransit must reject when the requester has no live active hull',
    ).not.toBe('SPOOLING');
  });
});
