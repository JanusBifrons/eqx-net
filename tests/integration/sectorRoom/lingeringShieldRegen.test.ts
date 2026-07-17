/**
 * Campaign PR 2.2 (anti-patterns review 2026-07, A11 / C-server 2 / Part D
 * #5) — failing-first lock for the LINGERING-HULL SHIELD REGEN gate.
 *
 * The bug (invariant #17's bug class): `tickShieldRegen` gated its ship
 * loop on `ship.alive` ONLY, while the collider restore + shield broadcast
 * inside the same loop gate on `ship.isActive`. A LINGERING hull
 * (isActive=false — disconnected/displaced/parked) therefore silently
 * regenerated its shield value while its worker collider stayed
 * hull-exposed and no client was ever told: incoming damage landed on a
 * shield nobody can see — the playtest "lingering ships still have
 * shields, but it's not visible" report (3 iterations).
 *
 * Contract locked here: a lingering hull's shield does NOT regenerate
 * while parked; the moment the hull is reclaimed (isActive=true again)
 * regen resumes. RED pre-fix: the parked hull's shield climbs back up.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

describe('SectorRoom integration — lingering hulls do not regen shields (campaign 2.2)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('a damaged-then-parked hull keeps its shield DOWN while lingering', { timeout: 15_000 }, async () => {
    const pid = randomUUID();
    const client = await harness.connectActive(pid, { shipKind: 'scout' });
    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;
    const [shipId, ship] = [...state.ships.entries()][0]!;
    expect(ship.playerId).toBe(pid);

    // Knock the shield down through the real damage choke point.
    const internal = (room as unknown as { _internals: { applyDamage(t: string, s: string, d: number): void } })._internals;
    internal.applyDamage(pid, 'attacker', ship.shield + 1);
    expect(state.ships.get(shipId)!.shield).toBe(0);

    // Park the hull (disconnect → linger).
    await harness.disconnectClient(client);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pid });
    const lingering = state.ships.get(shipId)!;
    expect(lingering.isActive).toBe(false);

    // Let the regen delay + several regen windows elapse: the catalogue
    // shieldRegenDelayTicks is 300 (= 5 s at 60 Hz), so 7 s guarantees the
    // regen path RAN and had ~2 s of regen steps to move the value.
    await new Promise((r) => setTimeout(r, 7_000));

    expect(
      state.ships.get(shipId)!.shield,
      'a LINGERING hull regenerated its shield — tickShieldRegen must gate on isActive (invariant #17): the collider stays hull-exposed and no client is told, so this is an invisible shield',
    ).toBe(0);
  });
});
