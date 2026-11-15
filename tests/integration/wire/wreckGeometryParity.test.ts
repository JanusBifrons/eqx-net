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
import { isWreckDescriptor, WreckDescriptorSchema, type WreckDescriptor } from '../../../src/shared-types/messages/snapshotMessages.js';
import { wreckPieceGeometry, type WreckFractureInputs } from '../../../src/core/destruction/wreckPieces.js';

function serverWreck(kind: string, seed: number, hit: { x: number; y: number }, damage: number) {
  const spawned: WreckPieceSpawn[] = [];
  const sys = new CapitalWreckSubsystem({
    serverTick: () => 5000,
    wreckKindOf: () => kind as 'battleship',
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

/**
 * Fracture v9 kill cuts on the wire: a descriptor with `cutKind` / `cutAng`
 * / `cutW` rebuilds, after the serialise round trip, exactly the pieces the
 * server's `wreckPieceGeometry` gives for the same inputs (the function its
 * bodies are built from), for a capital and a sub-capital, slice and channel.
 */
describe('wreck geometry with a kill cut: server inputs == client rebuild (v9)', () => {
  const cases: Array<[string, WreckFractureInputs]> = [
    ['battleship slice', { kindId: 'battleship', seed: 7, killX: 600, killY: -200, killBlowDamage: 0.9, recentDamageRate: 0.5, snapChance: 0.2, cutKind: 'slice', cutAng: 31000 }],
    ['battleship channel', { kindId: 'battleship', seed: 7, killX: 600, killY: -200, killBlowDamage: 0.9, recentDamageRate: 0.5, snapChance: 0.2, cutKind: 'channel', cutAng: 31000, cutW: 90.5 }],
    ['heavy-cruiser bow channel', { kindId: 'heavy-cruiser', seed: 99, killX: 0, killY: -2000, killBlowDamage: 2, recentDamageRate: 1, snapChance: 0.2, cutKind: 'channel', cutAng: 16384, cutW: 40 }],
    ['fighter slice', { kindId: 'fighter', seed: 4242, killX: 3, killY: -1, killBlowDamage: 0.4, recentDamageRate: 0.3, snapChance: 0.4, cutKind: 'slice', cutAng: 1234 }],
    ['fighter channel', { kindId: 'fighter', seed: 4242, killX: 3, killY: -1, killBlowDamage: 0.4, recentDamageRate: 0.3, snapChance: 0.4, cutKind: 'channel', cutAng: 1234, cutW: 1.25 }],
  ];
  for (const [name, inputs] of cases) {
    it(`${name}: every piece's parts, mass and radius match bit for bit`, () => {
      const server = wreckPieceGeometry(inputs);
      expect(server.length).toBeGreaterThanOrEqual(1);
      const desc: WreckDescriptor = {
        wreckId: 42, parentKind: inputs.kindId, seed: inputs.seed, killX: inputs.killX, killY: inputs.killY,
        killBlowDamage: inputs.killBlowDamage, recentDamageRate: inputs.recentDamageRate, snapChance: inputs.snapChance,
        algoVersion: FRACTURE_ALGO_VERSION, cutKind: inputs.cutKind, cutAng: inputs.cutAng, cutW: inputs.cutW,
      };
      const wire = JSON.parse(JSON.stringify([desc])) as WreckDescriptor[];
      expect(WreckDescriptorSchema.safeParse(wire[0]).success).toBe(true);
      expect(isWreckDescriptor(wire[0])).toBe(true);
      const store = new WreckGeometryStore();
      store.add(wire);
      for (const s of server) {
        const g = store.piece(42, s.index);
        expect(g, `piece ${s.index} rebuilt`).not.toBeNull();
        expect(g!.parts).toStrictEqual(s.parts);
        expect(g!.colliderParts).toStrictEqual(s.colliderParts);
        expect(Object.is(g!.mass, s.mass)).toBe(true);
        expect(Object.is(g!.radius, s.radius)).toBe(true);
      }
      expect(store.piece(42, server.length)).toBeNull();
      // The cut matters: without it the client would build other pieces.
      expect(wreckPieceGeometry({ ...inputs, cutKind: undefined, cutAng: undefined, cutW: undefined })).not.toEqual(server);
    });
  }

  it('a recycled wreck id whose only change is the cut is rebuilt', () => {
    const base: WreckDescriptor = {
      wreckId: 9, parentKind: 'battleship', seed: 7, killX: 600, killY: -200, killBlowDamage: 0.9,
      recentDamageRate: 0.5, snapChance: 0.2, algoVersion: FRACTURE_ALGO_VERSION,
    };
    const store = new WreckGeometryStore();
    store.apply([base]);
    const first = store.piece(9, 0);
    store.apply([{ ...base, cutKind: 'slice', cutAng: 100 }]);
    expect(store.piece(9, 0)).not.toBe(first);
  });

  it('malformed cut fields are refused by the schema and the hot-path check alike', () => {
    const base: WreckDescriptor = {
      wreckId: 9, parentKind: 'battleship', seed: 7, killX: 600, killY: -200, killBlowDamage: 0.9,
      recentDamageRate: 0.5, snapChance: 0.2, algoVersion: FRACTURE_ALGO_VERSION,
    };
    for (const bad of [{ cutKind: 'laser' }, { cutAng: 70000 }, { cutAng: 1.5 }, { cutW: -1 }, { cutW: Number.NaN }]) {
      const d = { ...base, ...bad };
      expect(WreckDescriptorSchema.safeParse(d).success, JSON.stringify(bad)).toBe(false);
      expect(isWreckDescriptor(d), JSON.stringify(bad)).toBe(false);
    }
  });
});
