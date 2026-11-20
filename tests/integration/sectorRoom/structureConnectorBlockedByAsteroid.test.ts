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
 *
 * Cables are socket-to-socket curves (structure restyle 0d): `canConnect` tries
 * every facing plug pair in reach and takes the first whose curve misses every
 * rock, so a small rock between the two is legitimately bent around. The rock
 * here is big enough that EVERY plug pair's curve hits it; the test asserts that
 * with the core `canConnect` against the room's live obstacles (and that the
 * same pair links with no rocks), so the geometry can't silently stop blocking.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { canConnect, type GridObstacle } from '../../../src/core/structures/Grid.js';
import { buildGridNodes } from '../../../src/server/structures/structureGridView.js';

/** The room's live connection obstacles (the same list `getObstacles` hands
 *  `autoConnectStructure`). */
function liveRocks(h: SectorTestHarness): GridObstacle[] {
  return (h.getServerRoom() as unknown as { obstacles: { rocks(): GridObstacle[] } }).obstacles.rocks();
}

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

    // A big rock fills the gap between the Capital's east face (x = -120) and
    // the connector at (400,0), wide enough that no plug pair's curve gets round it.
    expect(internals.spawnTestAsteroid('blocker-rock', 130, 0, 200)).toBe(true);

    // Capital at (-400,0), connector at (400,0): in cable reach, and
    // Capital↔Connector is legal under capital-only, so absent the rock they
    // WOULD auto-connect. The rock is on the way, so line of sight — not the
    // range gate — is what blocks here.
    const capId = await placeAndWait(room, 'capital', -400, 0);
    const conId = await placeAndWait(room, 'connector', 400, 0);

    // Precondition (core rule): with no rocks the pair links; with the live rock
    // every plug pair's cable is blocked.
    const nodes = buildGridNodes(internals.structureRegistry);
    const cap = nodes.get(capId)!, con = nodes.get(conId)!;
    expect(canConnect(cap, con, new Map(), nodes, []), 'the pair links in open space').toEqual({ ok: true });
    expect(canConnect(cap, con, new Map(), nodes, liveRocks(harness)), 'the rock blocks every plug pair')
      .toEqual({ ok: false, reason: 'blocked' });

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

    // Same geometry and rock, but the rock is well off the way (900 u north).
    expect(internals.spawnTestAsteroid('side-rock', 130, 900, 200)).toBe(true);

    const capId = await placeAndWait(room, 'capital', -400, 0);
    const conId = await placeAndWait(room, 'connector', 400, 0);

    expect(internals.structureRegistry.hasConnection(capId, conId)).toBe(true);
    expect(internals.structureRegistry.connectionCount(conId)).toBe(1);
  }, 25_000);
});
