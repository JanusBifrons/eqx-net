/**
 * Structures follow-ups, Item D — connectors must NOT auto-connect THROUGH an
 * asteroid. The core `canConnect` LOS rule only tested OTHER structures' AABBs;
 * asteroids (swarm kind=0) were invisible to it, so a freshly-placed structure
 * auto-wired straight through a rock. This locks the server-level WIRING: the
 * `SectorRoom` `getObstacles` hook threads the live asteroid poses (read from the
 * SAB) into `autoConnectStructure → canConnect`, so an asteroid on the connecting
 * segment blocks the auto-connection (the structure stays unpowered until the
 * player bridges around the rock — no placement rejection).
 *
 * Drives the full production path: `place_structure` message → owner resolve →
 * `StructurePlacementSubsystem.place` → `autoConnectStructure(registry, id,
 * getObstacles())`. `spawnTestAsteroid` (an `_internals` seam) seeds the rock and
 * `spawnOne` writes its SAB pose synchronously at spawn, so `getObstacles` sees
 * it immediately.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

describe('SectorRoom integration — connector blocked by asteroid (Item D)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); });

  /** Send `place_structure` and poll the registry until the record exists. */
  async function placeAndWait(
    room: Awaited<ReturnType<SectorTestHarness['connectAs']>>,
    kind: string,
    x: number,
    y: number,
  ): Promise<string> {
    const internals = harness.getServerRoom()!._internals;
    const before = new Set([...internals.structureRegistry.all()].map((s) => s.id));
    room.send('place_structure', { type: 'place_structure', kind, x, y });
    for (let i = 0; i < 80; i++) {
      const fresh = [...internals.structureRegistry.all()].find((s) => !before.has(s.id));
      if (fresh) return fresh.id;
      await harness.advance(25);
    }
    throw new Error(`place_structure(${kind}) never landed in the registry`);
  }

  it('an asteroid ON the connecting segment blocks the auto-connection', async () => {
    // Clean scene (no ambient ASTEROIDS field) so only the rock we seed below
    // exists — otherwise a default rock could land on the segment and confound.
    harness = await bootSectorTestServer({ droneCount: 0, asteroidConfig: [] });
    // Placement only needs `sessionToPlayer` (populated on join) — the ship
    // doesn't have to be active. `connectAs` avoids the client_ready handshake.
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    // Rock sits dead-centre between the two structure positions, on the segment.
    expect(internals.spawnTestAsteroid('blocker-rock', 0, 0, 60)).toBe(true);

    // Capital at (-150,0), connector at (150,0): edge dist 300-(80+24)=196, within
    // the Capital's WS-5 300 u reach, so absent the rock they WOULD auto-connect
    // (Capital↔Connector is legal under capital-only). The asteroid is on the
    // segment, so the LOS rule — not the range gate — is what blocks here.
    const capId = await placeAndWait(room, 'capital', -150, 0);
    const conId = await placeAndWait(room, 'connector', 150, 0);

    // The connector must NOT have auto-wired to the capital through the rock.
    expect(internals.structureRegistry.hasConnection(capId, conId)).toBe(false);
    expect(internals.structureRegistry.connectionCount(conId)).toBe(0);
  }, 25_000);

  it('positive control: with the asteroid OFF the segment the connection forms', async () => {
    // Clean scene (no ambient ASTEROIDS field) so only the rock we seed below
    // exists — otherwise a default rock could land on the segment and confound.
    harness = await bootSectorTestServer({ droneCount: 0, asteroidConfig: [] });
    const room = await harness.connectAs('player-2');
    const internals = harness.getServerRoom()!._internals;

    // Same geometry, but the rock is well off the (-300,0)→(300,0) segment.
    expect(internals.spawnTestAsteroid('side-rock', 0, 600, 60)).toBe(true);

    const capId = await placeAndWait(room, 'capital', -150, 0);
    const conId = await placeAndWait(room, 'connector', 150, 0);

    expect(internals.structureRegistry.hasConnection(capId, conId)).toBe(true);
    expect(internals.structureRegistry.connectionCount(conId)).toBe(1);
  }, 25_000);
});
