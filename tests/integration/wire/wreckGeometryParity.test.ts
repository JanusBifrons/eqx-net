/**
 * Capital destruction S2b — the cross-boundary geometry lock (#15).
 *
 * The SERVER side: the real `CapitalWreckSubsystem` breaks a capital and
 * spawns one body per piece (convex parts, mass, radius) and publishes one
 * `wrecks[]` descriptor. The CLIENT side: the real `WreckGeometryStore`
 * applies that descriptor (after a serialise round trip, as the snapshot
 * would) and rebuilds the pieces. They must be byte-identical: the client's
 * predWorld twin and its drawing sit exactly on the server's bodies, and no
 * vertex ever crosses the wire. A test crossing src/server ↔ src/client is
 * legal (boundary rules bind src/**, not tests/).
 */
import { describe, expect, it } from 'vitest';
import { CapitalWreckSubsystem, type WreckPieceSpawn } from '../../../src/server/rooms/CapitalWreckSubsystem.js';
import { WreckGeometryStore } from '../../../src/client/net/wreckGeometryStore.js';
import { FRACTURE_ALGO_VERSION } from '../../../src/core/destruction/fractureHull.js';
import type { WreckDescriptor } from '../../../src/shared-types/messages/snapshotMessages.js';

function serverWreck(kind: string, seed: number, hit: { x: number; y: number }, damage: number) {
  const spawned: WreckPieceSpawn[] = [];
  const sys = new CapitalWreckSubsystem({
    serverTick: () => 5000,
    capitalKindOf: () => kind as 'battleship',
    positionOf: () => null,
    spawnPiece: (s) => { spawned.push(s); return true; },
    removePiece: () => {},
    isLive: () => true,
    pieceAngle: () => 0,
    kickPiece: () => {},
  });
  sys.forcedSeed = seed;
  sys.noteHit('cap', 'shooter', damage, hit.x, hit.y);
  sys.onDeath('cap', kind as 'battleship', { x: 1234.5, y: -987.25, vx: 3, vy: -2, angle: 0.7, angvel: 0.01 }, 100_000);
  // The wire: the snapshot serialises the descriptor list.
  const wire = JSON.parse(JSON.stringify(sys.descriptors())) as WreckDescriptor[];
  return { spawned, wire };
}

describe('wreck geometry: server bodies == client rebuild (S2b)', () => {
  const cases: Array<[string, number, { x: number; y: number }, number]> = [
    ['battleship', 7, { x: 1500, y: -700 }, 60_000], // a heavy blow: many pieces
    ['battleship', 12345, { x: 900, y: -1100 }, 500], // a grind: few hulks
    ['heavy-cruiser', 99, { x: 1300, y: -950 }, 20_000],
    ['destroyer', 4242, { x: 1240, y: -1000 }, 2_000],
  ];
  for (const [kind, seed, hit, damage] of cases) {
    it(`${kind} seed ${seed}: every piece's parts, mass and radius match bit for bit`, () => {
      const { spawned, wire } = serverWreck(kind, seed, hit, damage);
      expect(spawned.length).toBeGreaterThanOrEqual(2);
      expect(wire).toHaveLength(1);
      const d = wire[0]!;
      expect(d.algoVersion).toBe(FRACTURE_ALGO_VERSION);
      expect(d.parentKind).toBe(kind);
      for (const s of spawned) expect(s.wreckId).toBe(d.wreckId);

      const store = new WreckGeometryStore();
      store.apply(wire);
      for (const s of spawned) {
        const g = store.piece(d.wreckId, s.pieceIndex);
        expect(g, `piece ${s.pieceIndex} rebuilt`).not.toBeNull();
        // toStrictEqual on numbers is Object.is: bit-for-bit, not "close".
        expect(g!.parts).toStrictEqual(s.parts);
        expect(g!.colliderParts).toStrictEqual(s.colliderParts);
        expect(Object.is(g!.mass, s.mass)).toBe(true);
        expect(Object.is(g!.radius, s.radius)).toBe(true);
      }
      expect(store.piece(d.wreckId, spawned.length)).toBeNull();
    });
  }

  it('a descriptor from another fracture version is dropped, never guessed at', () => {
    const { wire } = serverWreck('battleship', 7, { x: 1500, y: -700 }, 60_000);
    const store = new WreckGeometryStore();
    store.apply([{ ...wire[0]!, algoVersion: FRACTURE_ALGO_VERSION + 1 }]);
    expect(store.has(wire[0]!.wreckId)).toBe(false);
    expect(store.rejected).toBe(1);
  });

  it('a wreck that leaves the list is forgotten; a recycled id with new inputs is rebuilt', () => {
    const a = serverWreck('battleship', 7, { x: 1500, y: -700 }, 60_000).wire[0]!;
    const b = { ...serverWreck('battleship', 8, { x: 1500, y: -700 }, 60_000).wire[0]!, wreckId: a.wreckId };
    const store = new WreckGeometryStore();
    store.apply([a]);
    const first = store.piece(a.wreckId, 0);
    store.apply([b]);
    expect(store.piece(a.wreckId, 0)).not.toBe(first);
    store.apply([]);
    expect(store.has(a.wreckId)).toBe(false);
  });
});
