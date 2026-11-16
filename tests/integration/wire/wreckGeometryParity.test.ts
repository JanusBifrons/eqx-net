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

  // Fracture v11: around the sub-capital's burn-away share (0.2 of the hull)
  // the client drops exactly the pieces the server burned. A railgun channel
  // down a gunship 4 u (1x) off its keel leaves ~12 % (burns) and ~44 %
  // (drifts on): one piece, rebuilt bit for bit, and no second index.
  it('v11 burn-away: a gunship channel keeps one piece on both sides, its small bank burned on both', () => {
    const inputs: WreckFractureInputs = {
      kindId: 'gunship', seed: 3, killX: 4, killY: -16, killBlowDamage: 0.3, recentDamageRate: 0.3, snapChance: 0.2,
      cutKind: 'channel', cutAng: 16384, cutW: 8,
    };
    const server = wreckPieceGeometry(inputs);
    expect(server).toHaveLength(1);
    const desc: WreckDescriptor = {
      wreckId: 77, parentKind: 'gunship', seed: 3, killX: 4, killY: -16, killBlowDamage: 0.3, recentDamageRate: 0.3,
      snapChance: 0.2, algoVersion: FRACTURE_ALGO_VERSION, cutKind: 'channel', cutAng: 16384, cutW: 8,
    };
    const store = new WreckGeometryStore();
    store.add(JSON.parse(JSON.stringify([desc])) as WreckDescriptor[]);
    const g = store.piece(77, 0);
    expect(g).not.toBeNull();
    expect(g!.parts).toStrictEqual(server[0]!.parts);
    expect(g!.colliderParts).toStrictEqual(server[0]!.colliderParts);
    expect(Object.is(g!.mass, server[0]!.mass)).toBe(true);
    expect(store.piece(77, 1), 'the burned bank is not rebuilt').toBeNull();
  });

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

/**
 * Fracture v12 multi-cut (owner 2026-11-15, "one cut per beam";
 * capital-destruction.md "Multi-cut"): a hull or piece burned by several
 * cutting beams breaks along every line, and the descriptor carries the
 * further lines (`extraCuts`). The real `CapitalWreckSubsystem` (its burn
 * lines, two ships firing together) against the real `WreckGeometryStore`,
 * after a serialise round trip: the bodies and the client's pieces agree bit
 * for bit, for the kill split and the re-split, a late joiner included (#15,
 * #16).
 */
describe('wreck geometry with multi-cut lines: server bodies == client rebuild (v12)', () => {
  function multiCutServer() {
    const spawned: WreckPieceSpawn[] = [];
    const live = new Set<string>();
    let tick = 5000;
    const pose = (id: string) => {
      const s = spawned.find((p) => p.id === id);
      return s === undefined || !live.has(id) ? null : { x: s.x, y: s.y, vx: 0, vy: 0, angle: 0.7, angvel: 0 };
    };
    const sys = new CapitalWreckSubsystem({
      serverTick: () => tick,
      wreckKindOf: (id) => (id === 'cap' ? 'battleship' : null),
      positionOf: () => null,
      spawnPiece: (s) => { spawned.push(s); live.add(s.id); return true; },
      removePiece: (id) => { live.delete(id); },
      isLive: (id) => live.has(id),
      pieceAngle: () => 0.7,
      kickPiece: () => {},
      impulsePiece: () => {},
      piecePose: pose,
      piecePoseInto: (id, out) => { const p = pose(id); if (p === null) return false; Object.assign(out, p); return true; },
      hullPoseInto: (id, out) => { if (id !== 'cap') return false; out.x = 1234.5; out.y = -987.25; out.angle = 0.7; return true; },
      dropSalvage: () => {},
    });
    sys.forcedSeed = 7;
    return { sys, spawned, setTick: (t: number) => { tick = t; } };
  }

  function expectBodies(store: WreckGeometryStore, wreckId: number, bodies: WreckPieceSpawn[]): void {
    expect(bodies.length).toBeGreaterThan(0);
    for (const s of bodies) {
      const g = store.piece(wreckId, s.pieceIndex);
      expect(g, `wreck ${wreckId} piece ${s.pieceIndex}`).not.toBeNull();
      expect(g!.parts).toStrictEqual(s.parts);
      expect(g!.colliderParts).toStrictEqual(s.colliderParts);
      expect(Object.is(g!.mass, s.mass)).toBe(true);
      expect(Object.is(g!.radius, s.radius)).toBe(true);
    }
  }

  /** Two ships' heavy beams cross a battleship; the second kills it. */
  function killSplit() {
    const m = multiCutServer();
    const pose = { x: 1234.5, y: -987.25, vx: 3, vy: -2, angle: 0.7, angvel: 0.01 };
    m.sys.noteHit('cap', 'shipB', 100, 1234.5, -987.25, Math.cos(0.7), Math.sin(0.7), 'heavy_beam');
    m.sys.noteHit('cap', 'shipA', 100, 1234.5 - 2000, -987.25, 1, 0, 'heavy_beam');
    m.sys.onDeath('cap', 'battleship', pose, 1e6);
    return m;
  }

  it('kill split by two ships: the descriptor carries the second line; the client rebuilds every body', () => {
    const { sys, spawned } = killSplit();
    const wire = JSON.parse(JSON.stringify(sys.descriptors())) as WreckDescriptor[];
    expect(wire).toHaveLength(1);
    expect(wire[0]!.extraCuts).toHaveLength(1);
    expect(WreckDescriptorSchema.safeParse(wire[0]).success).toBe(true);
    expect(isWreckDescriptor(wire[0])).toBe(true);
    const store = new WreckGeometryStore();
    store.apply(wire);
    expectBodies(store, wire[0]!.wreckId, spawned);
    expect(store.piece(wire[0]!.wreckId, wreckPieceGeometry({ ...rootInputs(wire[0]!) }).length)).toBeNull();
  });

  it('re-split by three beams: the child carries two further lines; every child body rebuilds, a late joiner too', () => {
    const { sys, spawned, setTick } = killSplit();
    setTick(5000 + 10);
    const before = spawned.length;
    const piece = spawned.reduce((a, b) => (b.mass > a.mass ? b : a));
    const c = Math.cos(0.7), s = Math.sin(0.7);
    // Three beams through the piece's centre, 60° apart; the last wears it out.
    expect(sys.onWreckHit(piece.id, piece.x, piece.y, c, s, 1, 'heavy_beam', 'lance')).toBe(true);
    expect(sys.onWreckHit(piece.id, piece.x, piece.y, c * 0.5 - s * 0.866, s * 0.5 + c * 0.866, 1, 'mining_laser', 'miner')).toBe(true);
    expect(sys.onWreckHit(piece.id, piece.x, piece.y, -c * 0.5 - s * 0.866, -s * 0.5 + c * 0.866, 1e12, 'heavy_beam', 'lance2')).toBe(true);
    const wire = JSON.parse(JSON.stringify(sys.descriptors())) as WreckDescriptor[];
    const child = wire.find((d) => d.parentWreck !== undefined)!;
    expect(child, 'the piece broke into a child wreck').toBeDefined();
    expect(child.extraCuts).toHaveLength(2);
    for (const d of wire) {
      expect(WreckDescriptorSchema.safeParse(d).success).toBe(true);
      expect(isWreckDescriptor(d)).toBe(true);
    }
    const kids = spawned.slice(before);
    const store = new WreckGeometryStore();
    store.apply(wire);
    expectBodies(store, child.wreckId, kids);
    // A late joiner: the child first (a snapshot add), its root on a resync.
    const late = new WreckGeometryStore();
    late.add([child]);
    late.resync({ lo: 1, hi: child.wreckId, d: wire.filter((d) => d.wreckId !== child.wreckId) });
    expectBodies(late, child.wreckId, kids);
  });

  it('a recycled wreck id whose only change is the further lines is rebuilt; malformed lines are refused both ways', () => {
    const { sys } = killSplit();
    const d = JSON.parse(JSON.stringify(sys.descriptors()[0])) as WreckDescriptor;
    const store = new WreckGeometryStore();
    store.apply([d]);
    const first = store.piece(d.wreckId, 0);
    store.apply([{ ...d, extraCuts: [{ ...d.extraCuts![0]!, ang: (d.extraCuts![0]!.ang + 9000) % 65536 }] }]);
    expect(store.piece(d.wreckId, 0)).not.toBe(first);
    const line = { x: 1, y: 2, ang: 3 };
    for (const bad of [
      { extraCuts: [] },
      { extraCuts: [line, line, line, line] },
      { extraCuts: [{ ...line, ang: 70000 }] },
      { extraCuts: [{ ...line, ang: 1.5 }] },
      { extraCuts: [{ ...line, w: -1 }] },
      { extraCuts: [{ ...line, x: Number.NaN }] },
      { extraCuts: [line], cutKind: undefined, cutAng: undefined, cutW: undefined },
    ]) {
      const m = { ...d, ...bad };
      expect(WreckDescriptorSchema.safeParse(m).success, JSON.stringify(bad)).toBe(false);
      expect(isWreckDescriptor(JSON.parse(JSON.stringify(m))), JSON.stringify(bad)).toBe(false);
    }
  });
});

function rootInputs(d: WreckDescriptor): WreckFractureInputs {
  return {
    kindId: d.parentKind as 'battleship', seed: d.seed, killX: d.killX, killY: d.killY, killBlowDamage: d.killBlowDamage,
    recentDamageRate: d.recentDamageRate, snapChance: d.snapChance, cutKind: d.cutKind, cutAng: d.cutAng, cutW: d.cutW,
    extraCuts: d.extraCuts,
  };
}
