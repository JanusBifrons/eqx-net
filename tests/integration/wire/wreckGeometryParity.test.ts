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
import { WreckGeometryStore, resolveChildWreckPieces } from '../../../src/client/net/wreckGeometryStore.js';
import { FRACTURE_ALGO_VERSION, projectToOutline, type FracturePiece } from '../../../src/core/destruction/fractureHull.js';
import { isWreckDescriptor, WreckDescriptorSchema, type WreckDescriptor, type WreckSync } from '../../../src/shared-types/messages/snapshotMessages.js';
import { wreckPieceGeometry, type WreckFractureInputs } from '../../../src/core/destruction/wreckPieces.js';
import { wreckChainFracture, wreckChildGeometry, wreckChildSeed, type WreckChildStep } from '../../../src/core/destruction/wreckChildren.js';
import { wreckRootFracture } from '../../../src/core/destruction/wreckPieceFrame.js';
import { shipHullOutline } from '../../../src/core/geometry/shipHullOutline.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { WreckWireDeltas } from '../../../src/server/rooms/WreckWireDeltas.js';

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
    // v10: the heavy beam's wide slice (`cutKind` slice with a `cutW`).
    ['battleship wide slice', { kindId: 'battleship', seed: 7, killX: 600, killY: -200, killBlowDamage: 0.9, recentDamageRate: 0.5, snapChance: 0.2, cutKind: 'slice', cutAng: 31000, cutW: 30 }],
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

/**
 * Salvage stream (capital-destruction.md §S4 "Re-split"): a CHILD wreck rides
 * the wire as one descriptor per break, naming its parent wreck and piece.
 * The server builds a child from the chain's inputs with the shared
 * `wreckChildGeometry`; the client store resolves the same chain by walking
 * parent descriptors. The two must agree bit for bit at depth 2, whatever
 * order the descriptors arrive in (#15, #16).
 */
describe('wreck child chains: server chain geometry == client resolve (salvage)', () => {
  /** A deterministic hit on a raw piece: the midpoint of its longest edge. */
  function hitOn(p: FracturePiece): { x: number; y: number } {
    let best = -1;
    let at = { x: p.outline[0]!.x, y: p.outline[0]!.y };
    for (let i = 0; i < p.outline.length; i++) {
      const a = p.outline[i]!;
      const b = p.outline[(i + 1) % p.outline.length]!;
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      if (l > best) { best = l; at = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
    }
    return at;
  }

  /** The server side: root inputs, two breaks, and the descriptors it sends. */
  function serverChain(kindId: 'heavy-cruiser' | 'battleship' | 'fighter', seed: number) {
    const k = projectToOutline(shipHullOutline(getShipKind(kindId)), { x: 0.3e5, y: 1e5 });
    const root: WreckFractureInputs = { kindId, seed, killX: k.x, killY: k.y, killBlowDamage: 0.6, recentDamageRate: 0.4, snapChance: 0.2 };
    const h0 = hitOn(wreckRootFracture(root)[0]!);
    const step0: WreckChildStep = { pieceIndex: 0, killX: h0.x, killY: h0.y };
    const gen1 = wreckChainFracture({ root, steps: [step0] });
    const p1 = gen1.length - 1;
    const h1 = hitOn(gen1[p1]!);
    const step1: WreckChildStep = { pieceIndex: p1, killX: h1.x, killY: h1.y, cutKind: 'channel', cutAng: 9000, cutW: 4.5 };
    const serverGen1 = wreckChildGeometry({ root, steps: [step0] });
    const serverGen2 = wreckChildGeometry({ root, steps: [step0, step1] });
    const rootDesc: WreckDescriptor = {
      wreckId: 10, parentKind: kindId, seed, killX: root.killX, killY: root.killY, killBlowDamage: 0.6,
      recentDamageRate: 0.4, snapChance: 0.2, algoVersion: FRACTURE_ALGO_VERSION,
    };
    const child = (wreckId: number, parent: WreckDescriptor, s: WreckChildStep): WreckDescriptor => ({
      wreckId, parentWreck: parent.wreckId, parentPiece: s.pieceIndex, parentKind: kindId,
      seed: wreckChildSeed(parent.seed, s.pieceIndex), killX: s.killX, killY: s.killY,
      killBlowDamage: 0, recentDamageRate: 0, snapChance: 0, algoVersion: FRACTURE_ALGO_VERSION,
      cutKind: s.cutKind, cutAng: s.cutAng, cutW: s.cutW,
    });
    const c1 = child(11, rootDesc, step0);
    const c2 = child(12, c1, step1);
    // The wire: a serialise round trip, as the welcome / snapshot would.
    const wire = JSON.parse(JSON.stringify([rootDesc, c1, c2])) as WreckDescriptor[];
    return { serverGen1, serverGen2, wire };
  }

  function expectSame(store: WreckGeometryStore, wreckId: number, server: ReturnType<typeof wreckChildGeometry>): void {
    expect(server.length).toBeGreaterThanOrEqual(1); // a break may leave a single piece
    for (let i = 0; i < server.length; i++) {
      const g = store.piece(wreckId, i);
      expect(g, `wreck ${wreckId} piece ${i}`).not.toBeNull();
      expect(g!.parts).toStrictEqual(server[i]!.parts);
      expect(g!.colliderParts).toStrictEqual(server[i]!.colliderParts);
      expect(Object.is(g!.mass, server[i]!.mass)).toBe(true);
      expect(Object.is(g!.radius, server[i]!.radius)).toBe(true);
    }
    expect(store.piece(wreckId, server.length)).toBeNull();
  }

  for (const [kind, seed] of [['heavy-cruiser', 4242], ['battleship', 7], ['fighter', 99]] as const) {
    it(`${kind}: every descriptor passes both checks; depth-1 and depth-2 children match bit for bit`, () => {
      const { serverGen1, serverGen2, wire } = serverChain(kind, seed);
      for (const d of wire) {
        expect(WreckDescriptorSchema.safeParse(d).success).toBe(true);
        expect(isWreckDescriptor(d)).toBe(true);
      }
      const store = new WreckGeometryStore();
      store.apply(wire);
      expectSame(store, 11, serverGen1);
      expectSame(store, 12, serverGen2);
    });
  }

  it('out of order: the child arrives before its parents, resolves once they land', () => {
    const { serverGen2, serverGen1, wire } = serverChain('heavy-cruiser', 4242);
    const [root, c1, c2] = wire as [WreckDescriptor, WreckDescriptor, WreckDescriptor];
    const store = new WreckGeometryStore();
    store.add([c2]); // grandchild first (a snapshot add before its parents)
    expect(store.has(12)).toBe(true);
    expect(store.piece(12, 0)).toBeNull(); // deferred, not dropped
    store.add([c1]);
    expect(store.piece(12, 0)).toBeNull(); // root still missing
    expect(store.piece(11, 0)).toBeNull();
    store.resync({ lo: 1, hi: 11, d: [root] });
    expectSame(store, 12, serverGen2);
    expectSame(store, 11, serverGen1);
    expect(store.rejected).toBe(0);
  });

  it('a parent that leaves unresolves its descendants; a recycled parent id rebuilds them', () => {
    const { serverGen2, wire } = serverChain('heavy-cruiser', 4242);
    const [root, c1, c2] = wire as [WreckDescriptor, WreckDescriptor, WreckDescriptor];
    const store = new WreckGeometryStore();
    store.apply([root, c1, c2]);
    expectSame(store, 12, serverGen2);
    store.remove([11]);
    expect(store.piece(12, 0)).toBeNull();
    store.add([c1]);
    expectSame(store, 12, serverGen2);
    // A different wreck under the root's id: the chain no longer links up
    // (the child's seed is not derived from it), so the child is unresolved.
    store.add([{ ...root, seed: root.seed + 1 }]);
    expect(store.piece(12, 0)).toBeNull();
    store.add([root]);
    expectSame(store, 12, serverGen2);
  });

  it('the renderer path (geometryFor) resolves a child whose parents it saw, in any order', () => {
    const { serverGen2, wire } = serverChain('battleship', 7);
    const [root, c1, c2] = wire as [WreckDescriptor, WreckDescriptor, WreckDescriptor];
    const store = new WreckGeometryStore();
    expect(store.geometryFor(c2)).toBeNull();
    store.geometryFor(c1);
    store.geometryFor(root);
    const g = store.geometryFor(c2);
    expect(g).not.toBeNull();
    expect(g!.map((p) => p.parts)).toStrictEqual(serverGen2.map((p) => p.parts));
  });

  it('the pure resolver agrees with the server chain; a broken link resolves to null', () => {
    const { serverGen2, wire } = serverChain('fighter', 99);
    const byId = new Map(wire.map((d) => [d.wreckId, d] as const));
    const c2 = byId.get(12)!;
    expect(resolveChildWreckPieces(c2, (id) => byId.get(id))).toStrictEqual(serverGen2);
    expect(resolveChildWreckPieces({ ...c2, seed: (c2.seed ^ 1) >>> 0 }, (id) => byId.get(id))).toBeNull();
    expect(resolveChildWreckPieces({ ...c2, parentKind: 'battleship' }, (id) => byId.get(id))).toBeNull();
    // A parent cycle on a malformed wire stops at the depth guard.
    const loopA: WreckDescriptor = { ...c2, wreckId: 20, parentWreck: 21 };
    const loopB: WreckDescriptor = { ...c2, wreckId: 21, parentWreck: 20 };
    const loops = new Map([[20, loopA], [21, loopB]]);
    expect(resolveChildWreckPieces(loopA, (id) => loops.get(id))).toBeNull();
  });

  it('WreckWireDeltas carries the parent link unchanged in adds and the resync chunk', () => {
    const { wire } = serverChain('heavy-cruiser', 4242);
    const deltas = new WreckWireDeltas();
    deltas.step(0, wire, 1);
    const out = JSON.parse(JSON.stringify({ adds: deltas.adds, sync: deltas.sync })) as { adds: WreckDescriptor[]; sync: WreckSync };
    expect(out.adds).toStrictEqual(wire);
    expect(out.sync.d).toStrictEqual(wire);
  });

  it('malformed parent links are refused by the schema and the hot-path check alike', () => {
    const base: WreckDescriptor = {
      wreckId: 9, parentKind: 'battleship', seed: 7, killX: 600, killY: -200, killBlowDamage: 0,
      recentDamageRate: 0, snapChance: 0, algoVersion: FRACTURE_ALGO_VERSION,
    };
    for (const bad of [
      { parentWreck: 3 }, // piece missing
      { parentPiece: 0 }, // wreck missing
      { parentWreck: 9, parentPiece: 0 }, // its own parent
      { parentWreck: 0, parentPiece: 0 },
      { parentWreck: 0x10000, parentPiece: 0 },
      { parentWreck: 3, parentPiece: 256 },
      { parentWreck: 3, parentPiece: -1 },
      { parentWreck: 3, parentPiece: 1.5 },
    ]) {
      const d = { ...base, ...bad };
      expect(WreckDescriptorSchema.safeParse(d).success, JSON.stringify(bad)).toBe(false);
      expect(isWreckDescriptor(d), JSON.stringify(bad)).toBe(false);
    }
    const ok = { ...base, parentWreck: 3, parentPiece: 255 };
    expect(WreckDescriptorSchema.safeParse(ok).success).toBe(true);
    expect(isWreckDescriptor(ok)).toBe(true);
  });
});
