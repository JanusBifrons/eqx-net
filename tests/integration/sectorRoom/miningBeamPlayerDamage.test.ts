/**
 * WS-4 Phase 3 / R2.27 — integration lock for the mining beam's light
 * player-damage RAY. The feature LIVES here (Invariant #13): a player who flies
 * into an active Miner's beam takes light damage through the real
 * structure-grid → tickMiners → damagePlayersInMiningBeam → applyDamage path.
 *
 * Geometry: a pre-built powered grid (capital@0,0 + relay@0,350 + solar@250,400 + miner@-180,420)
 * mines a rock@-750,420, so the mining beam runs along y=420 from the miner to the
 * rock. A player parked at (-500,420) sits squarely in that beam.
 *
 * Drives the grid deterministically via the _internals seams (pulseStructureGrid
 * sets the miner's target; tickStructureTurrets ticks tickMiners → beam +
 * player damage) rather than waiting on the 1 Hz / 100 ms wall-clock timers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState, ShipState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

function getRoomById(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

describe('SectorRoom integration — mining beam player hazard (WS-4 Phase 3 / R2.27)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
      asteroidConfig: [], // rock-free sector — the scenario seeds the only rock
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 },
        // WS-5 capital-only-connectors: the solar + miner route through a
        // Connector relay offset on +y (its LOS clears the Capital to both the
        // +x solar and the −x miner). The miner→rock beam (along −x at y=0) is
        // unaffected by the relay.
        // Phase V footprints: relay above the Capital, solar right of it, miner
        // left of it; the rock sits along the miner's row so the beam runs
        // along y = 420 from x = -180 to -750.
        { kind: 'connector', x: 0, y: 350 },
        { kind: 'solar', x: 250, y: 400 },
        { kind: 'miner', x: -180, y: 420 },
      ],
      scenarioAsteroids: [{ x: -750, y: 420, radius: 30 }],
    });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  function findShip(state: SectorState, pid: string): ShipState {
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) return s;
    throw new Error('ship gone: ' + pid);
  }

  it('a player parked in an active mining beam takes light damage', async () => {
    const pid = randomUUID();
    // Spawn the player ON the miner→rock beam line (y=420, between -180 and -750).
    const cr = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: -500, spawnY: 420 });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });
    const room = getRoomById(cr.roomId);
    const state = room.state as SectorState;
    const internal = room._internals;

    // Let the worker write the player's pose into shipPoseCache.
    await harness.advance(150);

    // Pulse the grid a few times: rebuild topology → power the miner (capital+50
    // + solar+30 − miner 60 = +20) → processMining sets the rock as the target.
    for (let i = 0; i < 4; i++) internal.pulseStructureGrid();
    await harness.advance(50);

    // The miner is powered + mining the rock (target set, beam endpoints cached).
    const miner = [...internal.structureRegistry.all()].find((r) => r.kind === 'miner')!;
    expect(miner.miningTargetEntityId, 'miner acquired the rock (powered + in range)').toBeDefined();

    const shieldBefore = findShip(state, pid).shield;
    const hullBefore = findShip(state, pid).health;

    // Force the next mining-beam broadcast: the room's own 100 ms timer may have
    // just fired a beam and tripped the wall-clock cadence gate, which would
    // suppress our manual tick and make the damage non-deterministic. Resetting
    // the gate guarantees this tick broadcasts the beam + applies the
    // player-damage ray to the ship sitting in it.
    miner.lastMiningBeamMs = undefined;
    internal.tickStructureTurrets();
    await harness.advance(50);

    const after = findShip(state, pid);
    const dropped = (shieldBefore - after.shield) + (hullBefore - after.health);
    // FAILS on current code: there is no mining-beam → player damage path, so a
    // player sitting in the beam is untouched (dropped === 0).
    expect(dropped, 'player took light mining-beam damage').toBeGreaterThan(0);
  }, 30_000);

  it('a player OUTSIDE the beam corridor is untouched', async () => {
    const pid = randomUUID();
    // Far off the y=420 beam line.
    const cr = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: -500, spawnY: 800 });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });
    const room = getRoomById(cr.roomId);
    const state = room.state as SectorState;
    const internal = room._internals;

    await harness.advance(150);
    for (let i = 0; i < 4; i++) internal.pulseStructureGrid();
    await harness.advance(50);

    const shieldBefore = findShip(state, pid).shield;
    internal.tickStructureTurrets();
    await harness.advance(50);

    expect(findShip(state, pid).shield).toBe(shieldBefore); // not in the beam → no damage
  }, 30_000);
});
