/**
 * Slot-firing + energy integration test (weapons/energy/AI overhaul §3).
 *
 * Verifies the server-side energy authority through the real wire:
 *   1. A slot trigger drains energy ONCE per trigger, not per mount — the
 *      interceptor's twin beams cost one beam-slot's energy (≈5), not 2×.
 *   2. The recipient's OWN snapshot entry carries `energy`; it drops on fire.
 *   3. The boost bit is stripped when the pool is empty (no boosting state).
 *
 * Crosses the Colyseus wire (energy lives at the message/room seam), per
 * Invariant #13. White-box reads of `state.ships` + `boostingPlayers` mirror
 * the existing missile/hit-ack integration tests.
 *
 * NOTE (2026-06-01): the physics-worker-backed harness crashes in some
 * sandboxes ("physics worker exited unexpectedly"); this spec is a CI
 * regression artifact. The deterministic energy math is unit-locked in
 * src/core/combat/Energy.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import type { Room as ServerRoom } from 'colyseus';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState, ShipState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';
import { getWeapon } from '../../../src/core/combat/WeaponCatalogue.js';
import { resolveSlotEnergyCost } from '../../../src/core/combat/Energy.js';
import { SHIP_KINDS } from '../../../src/shared-types/shipKinds.js';

interface EnergyTestInternals {
  serverTick: number;
  boostingPlayers: Set<string>;
}

function getRoomById(roomId: string): ServerRoom<SectorState> {
  return matchMaker.getLocalRoomById(roomId) as unknown as ServerRoom<SectorState>;
}

describe('SectorRoom integration — slot firing + energy authority', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  async function join(shipKind: string, extra: Record<string, unknown> = {}): Promise<{
    pid: string; cr: ClientRoom<SectorState>; room: ServerRoom<SectorState>; ship: ShipState;
  }> {
    const pid = randomUUID();
    const cr = (await harness.connectActive(pid, { shipKind, spawnX: 0, spawnY: 0, ...extra })) as ClientRoom<SectorState>;
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });
    const room = getRoomById(cr.roomId);
    const state = room.state as SectorState;
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) return { pid, cr, room, ship: s };
    throw new Error('ship not found after join');
  }

  it('a twin-beam slot drains energy ONCE per trigger, not per mount', async () => {
    const shooter = await join('interceptor');
    const internals = shooter.room as unknown as EnergyTestInternals;
    await harness.advance(100);

    const slotCost = resolveSlotEnergyCost(SHIP_KINDS.interceptor); // = one beam (5)
    expect(slotCost).toBe(getWeapon('hitscan').energyCost);
    expect(SHIP_KINDS.interceptor.mounts).toHaveLength(2);

    const before = shooter.ship.energy;
    shooter.cr.send('fire', {
      type: 'fire', tick: internals.serverTick, clientShotId: 'e1', weapon: 'hitscan', dirAngle: 0, slotId: 'primary',
    });
    // Capture the pool at its TROUGH — the first observed dip after the
    // spend lands. Energy regenerates every tick with NO post-spend delay
    // (see Energy.ts `regenEnergyStep`), so reading after a fixed wall-clock
    // window lets regen mask the single-slot drain and land it on the float
    // boundary of the lower bound. The first dip is the deepest: the spend
    // is a single-tick event, later ticks only refill the pool.
    let trough = before;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const e = shooter.ship.energy;
      if (e < before - 0.5) { trough = e; break; }
      await harness.advance(8);
    }

    const drained = before - trough;
    // Drain is ONE slot cost (modulo at most a tick of regen), never 2×
    // (which would be the per-mount sum for the twin beams).
    expect(drained).toBeGreaterThan(slotCost - 2);
    expect(drained).toBeLessThan(slotCost * 2 - 1);
  }, 20_000);

  it('the recipient OWN snapshot entry carries energy and it drops on fire', async () => {
    const shooter = await join('scout');
    const internals = shooter.room as unknown as EnergyTestInternals;

    let lastSnap: SnapshotMessage | null = null;
    shooter.cr.onMessage('snapshot', (s: SnapshotMessage) => { lastSnap = s; });

    // Wake the broadcast loop and wait for a snapshot carrying our energy.
    harness.sendThrust(shooter.cr);
    await harness.advance(200);
    const ownKey = shooter.ship.shipInstanceId;
    const e0 = lastSnap ? (lastSnap as SnapshotMessage).states[ownKey]?.energy : undefined;
    expect(typeof e0).toBe('number');

    // Fire a burst to draw the pool down, then confirm the wire value fell.
    for (let i = 0; i < 6; i++) {
      shooter.cr.send('fire', {
        type: 'fire', tick: internals.serverTick + i, clientShotId: `b${i}`, weapon: 'hitscan', dirAngle: 0, slotId: 'primary',
      });
      await harness.advance(40);
    }
    const eAfter = lastSnap ? (lastSnap as SnapshotMessage).states[ownKey]?.energy : undefined;
    expect(typeof eAfter).toBe('number');
    expect(eAfter!).toBeLessThan(e0!);
  }, 20_000);

  it('boost is stripped when the pool is empty (no boosting state)', async () => {
    const shooter = await join('scout', { initialEnergy: 0 });
    const internals = shooter.room as unknown as EnergyTestInternals;

    // Hold boost + thrust on an empty pool. The input handler must strip the
    // boost bit, so the player never enters the boosting set. The pool is
    // pinned empty before each input because energy regenerates every tick
    // with no delay (scout regen 0.2/tick ≪ BOOST_TICK_COST 1.0): without
    // the reset the `initialEnergy: 0` pool refills above the boost cost
    // during the join-handshake + test window and the gate (correctly) stops
    // stripping, defeating the empty-pool premise.
    for (let i = 0; i < 3; i++) {
      shooter.ship.energy = 0;
      shooter.cr.send('input', {
        type: 'input', tick: internals.serverTick + i,
        thrust: true, turnLeft: false, turnRight: false, boost: true, reverse: false,
      });
      await harness.advance(30);
    }
    expect(internals.boostingPlayers.has(shooter.pid)).toBe(false);
  }, 20_000);
});
