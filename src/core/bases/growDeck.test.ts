/**
 * Base platforms slice 23 — `growBase` with the `deck` option lays the base on
 * plates, legal under the PLAYER's deck rules; without it the output is
 * byte-identical to before the slice.
 */
import { describe, expect, it } from 'vitest';
import { getStructureKind, isConnectorKind, structureHalfExtents } from '../../shared-types/structureKinds.js';
import { canConnect, type GridNode } from '../structures/Grid.js';
import { Connection } from '../structures/Connection.js';
import { placementRejection, type PlacementFootprint } from '../structures/placementRules.js';
import { snapPlacementToDeck } from '../structures/deckPlacement.js';
import { isShieldEmitterKind } from '../structures/gateGeometry.js';
import { PlateSet, plateCentreAtWorldInto } from '../hex/plateSet.js';
import { DECK_HEX_SIZE, PLATE_DIRS, isPlateCentreHex, plateOfHexInto } from '../hex/plates.js';
import type { DeckSnap } from '../hex/deckSnap.js';
import { pixelToAxialInto } from '../hex/hex.js';
import { BASE_GROWTH_VERSION, growBase, type GrownBase } from './growBase.js';
import { DECK_HEXES_PER_PLATE, DECK_HEXES_PER_PLATE_DENSE, deckBaseOriginInto, type GrowBaseOptions } from './growDeck.js';
import type { BaseProfile, BaseRole, BaseTier } from './baseProfile.js';

function profile(tier: BaseTier, role: BaseRole, fenced = true): BaseProfile {
  const wealth = { outpost: 5_000, settlement: 16_000, stronghold: 50_000, citadel: 120_000 }[tier];
  return { tier, role, ownerFaction: 'traders', wealth, levelCap: tier === 'citadel' ? 5 : 2, fenced };
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

/** Fence parts and gate roads (slice 26). */
const FENCE = new Set(['shield_pylon', 'shield_gate']);
const POWER = new Set(['solar', 'reactor', 'battery', 'battery_bank']);
const FEATURES = ['asteroid', 'nebula', 'minerals'] as const;
const CASES: Array<[BaseTier, BaseRole, boolean, number]> = [
  ['outpost', 'mining', true, 1], ['settlement', 'refinery', true, 7], ['settlement', 'trade', false, 9],
  ['stronghold', 'military', true, 42], ['citadel', 'workshop', true, 1234],
];

function node(id: string, kind: string, x: number, y: number, rot = 0): GridNode {
  const k = getStructureKind(kind);
  const { hw, hh } = structureHalfExtents(kind, rot);
  return {
    id, kind, x, y, rot: (rot * Math.PI) / 180, radius: k.radius, halfW: hw, halfH: hh, isHub: k.isHub,
    isCapital: kind === 'capital', isConnector: isConnectorKind(kind), isShieldPylon: isShieldEmitterKind(kind),
    maxConnections: k.maxConnections, connectionRange: k.connectionRange,
    powerOutput: k.powerOutput, powerConsumption: k.powerConsumption, isConstructed: true,
  };
}

/** Re-check a deck base independently: the first placement lays the origin
 *  plate; every later one passes the player's deck rule against the plates
 *  laid so far, sits exactly where the player's snap puts it, and every edge
 *  passes the deck `canConnect`. Returns the plates and how many structures
 *  the Capital reaches. */
function verifyDeck(b: GrownBase): { plates: PlateSet<number>; reached: number } {
  const plates = new PlateSet<number>();
  const deck = { plates, owner: 'o' };
  const placed: PlacementFootprint[] = [];
  const nodes = new Map<string, GridNode>();
  const snap: DeckSnap = { x: 0, y: 0, q: 0, r: 0, rhombus: -1, rot: -1, slot: 'hex' };
  b.placements.forEach((p, i) => {
    const rot = p.rot ?? 0;
    expect(placementRejection(p.kind, p.x, p.y, placed, null, rot, undefined, i === 0 ? null : deck), `placement ${i} ${p.kind}`).toBeNull();
    snapPlacementToDeck(p.kind, p.x, p.y, snap, rot);
    expect([snap.x, snap.y, snap.rot], `${i} ${p.kind} on its deck slot`).toEqual([p.x, p.y, rot]);
    const nd = node('s' + i, p.kind, p.x, p.y, rot);
    placed.push({ x: p.x, y: p.y, radius: nd.radius, halfW: nd.halfW!, halfH: nd.halfH!, kind: p.kind, rot });
    nodes.set(nd.id, nd);
    plates.upsert(i, 'o', p.kind, p.x, p.y);
  });
  const adj = new Map<string, Connection[]>();
  let cid = 0;
  for (const [a, c] of b.edges) {
    const na = nodes.get('s' + a)!, nc = nodes.get('s' + c)!;
    expect(canConnect(na, nc, adj, nodes, undefined, undefined, undefined, true), `edge ${a}-${c}`).toEqual({ ok: true });
    const con = new Connection(cid++, na.id, nc.id, 1, -1, -1);
    (adj.get(na.id) ?? adj.set(na.id, []).get(na.id)!).push(con);
    (adj.get(nc.id) ?? adj.set(nc.id, []).get(nc.id)!).push(con);
  }
  const capId = 's' + b.placements.findIndex((p) => p.kind === 'capital');
  const seen = new Set([capId]);
  const q = [capId];
  while (q.length) {
    const id = q.pop()!;
    for (const c of adj.get(id) ?? []) {
      const o = c.getOtherNode(id)!;
      if (!seen.has(o)) { seen.add(o); q.push(o); }
    }
  }
  return { plates, reached: seen.size };
}

/** Per-plate outer-hex use of a deck base; asserts no plate exceeds `cap`
 *  and nothing stands on an anchor's yard. */
function density(b: GrownBase, cap: number): { plates: number; buildings: number; used: number; maxPerPlate: number } {
  const anchors = new Set<string>();
  const usedPerPlate = new Map<string, Set<string>>();
  const PI = { i: 0, j: 0 };
  const h = { q: 0, r: 0 };
  for (const p of b.placements) {
    if (isConnectorKind(p.kind) && plateCentreAtWorldInto(p.x, p.y, PI)) { anchors.add(`${PI.i},${PI.j}`); continue; }
    // The fence stands on seams; a gate's road is open floor (slice 26).
    if (FENCE.has(p.kind) || p.kind === 'road') continue;
    // A small kind sits on a rhombus of its hex: that hex is the one used.
    pixelToAxialInto(p.x, p.y, DECK_HEX_SIZE, h);
    expect(isPlateCentreHex(h.q, h.r), `${p.kind} off the anchor's yard`).toBe(false);
    plateOfHexInto(h.q, h.r, PI);
    const pk = `${PI.i},${PI.j}`;
    (usedPerPlate.get(pk) ?? usedPerPlate.set(pk, new Set()).get(pk)!).add(`${h.q},${h.r}`);
  }
  let used = 0, maxPerPlate = 0;
  for (const s of usedPerPlate.values()) { expect(s.size).toBeLessThanOrEqual(cap); used += s.size; maxPerPlate = Math.max(maxPerPlate, s.size); }
  // Not counted: the fence and its roads, and power (a fence's length, so its
  // draw, depends on the layout: slice 26).
  const skip = b.placements.filter((p) => FENCE.has(p.kind) || p.kind === 'road' || POWER.has(p.kind)).length;
  return { plates: anchors.size, buildings: b.placements.length - anchors.size - skip, used, maxPerPlate };
}

describe('growBase deck option (base platforms 23)', () => {
  it('bumps the growth version', () => {
    expect(BASE_GROWTH_VERSION).toBe(27);
  });

  it('flag off: output byte-identical to before the slice (default and explicit false)', () => {
    // Fingerprints taken on the spike tip before slice 23.
    const before = ['86956c58', '327f7664', '660bdd39', 'ab11868a', '6f45abaf'];
    const plain = CASES.map(([t, r, f, s]) => fnv(JSON.stringify(growBase(profile(t, r, f), s, [...FEATURES]))));
    const off = CASES.map(([t, r, f, s]) => fnv(JSON.stringify(growBase(profile(t, r, f), s, [...FEATURES], { deck: false }))));
    expect(plain).toEqual(before);
    expect(off).toEqual(before);
  });

  // Slice 25: the same invariants hold for a dense (asteroid-field) base.
  for (const dense of [false, true]) for (const [tier, role, fenced, seed] of CASES) {
    it(`${dense ? 'dense ' : ''}${tier} ${role}${fenced ? ' (fenced)' : ''}: plates contiguous, every piece on a deck slot under the player rules`, () => {
      const b = growBase(profile(tier, role, fenced), seed, [...FEATURES], dense ? { deck: true, dense: true } : { deck: true });
      const flat = growBase(profile(tier, role, fenced), seed, [...FEATURES]);
      const { plates, reached } = verifyDeck(b);
      expect(reached, 'every structure reachable from the Capital').toBe(b.placements.length);
      expect(b.placements.filter((p) => p.kind === 'capital')).toHaveLength(1);
      // Slice 26: a fenced deck rings itself (growDeckFence.test.ts checks the ring).
      if (fenced) expect(b.fencePylons * b.fenceGates).toBeGreaterThan(0);
      else expect(b.fencePylons + b.fenceGates).toBe(0);
      // Every connector is a plate anchor; one per plate.
      const PI = { i: 0, j: 0 };
      const conns = b.placements.filter((p) => isConnectorKind(p.kind));
      for (const c of conns) expect(plateCentreAtWorldInto(c.x, c.y, PI), `connector (${c.x}, ${c.y}) on a plate centre`).toBe(true);
      expect(plates.plateCount('o')).toBe(conns.length);
      expect(b.placements[0]!.x === 0 && b.placements[0]!.y === 0 && b.placements[0]!.kind === 'connector').toBe(true);
      // Contiguous: every plate reaches the origin through bordering plates.
      const list: Array<[number, number]> = [];
      plates.forEachPlate('o', (i, j) => list.push([i, j]));
      const key = (i: number, j: number) => `${i},${j}`;
      const have = new Set(list.map(([i, j]) => key(i, j)));
      const seen = new Set([key(0, 0)]);
      const q: Array<[number, number]> = [[0, 0]];
      while (q.length) {
        const [i, j] = q.pop()!;
        for (const d of PLATE_DIRS) {
          const k = key(i + d.i, j + d.j);
          if (have.has(k) && !seen.has(k)) { seen.add(k); q.push([i + d.i, j + d.j]); }
        }
      }
      expect(seen.size).toBe(have.size);
      // Every building stands on a plate that exists (the deck rule above
      // checks it too), and the base keeps what it bought (bar the fence and
      // its own connectors).
      // (A fence post or gate on the deck's outer seam touches it from outside.)
      for (const p of b.placements) if (!FENCE.has(p.kind)) expect(plates.plateAtWorld('o', p.x, p.y), `${p.kind} on a plate`).toBe(true);
      const bought = (g: GrownBase) => g.placements.filter((p) => !isConnectorKind(p.kind) && p.kind !== 'shield_pylon' && p.kind !== 'shield_gate').length;
      expect(bought(b)).toBeGreaterThanOrEqual(bought(flat) - 2);
      expect(b.netPower).toBeGreaterThanOrEqual(0);
    });
  }

  // Slice 24 — space is cheap: a plate builds on at most DECK_HEXES_PER_PLATE
  // of its 6 outer hexes, so at least half of all outer hexes are open floor.
  for (const [tier, role, fenced, seed] of CASES) {
    it(`${tier} ${role}: mostly empty deck (≥ half of every plate's outer hexes open)`, () => {
      const d = density(growBase(profile(tier, role, fenced), seed, [...FEATURES], { deck: true }), DECK_HEXES_PER_PLATE);
      console.log(`${tier} ${role}: ${d.plates} plates, ${d.buildings} buildings on ${d.used}/${d.plates * 6} outer hexes`);
      expect(d.used * 2).toBeLessThanOrEqual(d.plates * 6);
    });
  }

  // Slice 25 — a dense (asteroid-field) base packs up to all 6 outer hexes,
  // so it lays fewer plates than the sparse base for the same purchases.
  for (const [tier, role, fenced, seed] of CASES) {
    it(`${tier} ${role}: dense packs more hexes per plate on fewer plates than sparse`, () => {
      const sparseB = growBase(profile(tier, role, fenced), seed, [...FEATURES], { deck: true });
      const denseB = growBase(profile(tier, role, fenced), seed, [...FEATURES], { deck: true, dense: true });
      const sp = density(sparseB, DECK_HEXES_PER_PLATE);
      const dn = density(denseB, DECK_HEXES_PER_PLATE_DENSE);
      console.log(`${tier} ${role}: sparse ${sp.plates} plates ${sp.used}/${sp.plates * 6} hexes; dense ${dn.plates} plates ${dn.used}/${dn.plates * 6} hexes (max ${dn.maxPerPlate}/plate)`);
      // A fenced sparse deck's longer ring counts toward the tier's structure
      // cap (fence included), so it may buy less than the dense one (slice 26).
      if (fenced) expect(dn.buildings, 'dense keeps every building').toBeGreaterThanOrEqual(sp.buildings);
      else expect(dn.buildings, 'dense keeps every building').toBe(sp.buildings);
      if (fenced) expect(dn.plates).toBeLessThanOrEqual(sp.plates);
      else expect(dn.plates).toBeLessThan(sp.plates);
      expect(dn.maxPerPlate).toBeGreaterThan(DECK_HEXES_PER_PLATE);
    });
  }

  it('dense needs the deck: without it the row base is unchanged', () => {
    const p = profile('settlement', 'refinery');
    const opts: GrowBaseOptions = { dense: true };
    expect(growBase(p, 7, [...FEATURES], opts)).toEqual(growBase(p, 7, [...FEATURES]));
    expect(growBase(p, 7, [...FEATURES], { deck: true, dense: false })).toEqual(growBase(p, 7, [...FEATURES], { deck: true }));
  });

  it('dense is deterministic per seed', () => {
    const p = profile('stronghold', 'military');
    expect(growBase(p, 42, [], { deck: true, dense: true })).toEqual(growBase(p, 42, [], { deck: true, dense: true }));
  });

  it('is deterministic per seed', () => {
    const p = profile('settlement', 'workshop');
    expect(growBase(p, 5, [], { deck: true })).toEqual(growBase(p, 5, [], { deck: true }));
  });

  it('a deck base is seeded on the nearest plate centre', () => {
    const o = deckBaseOriginInto(5000, -3000, { x: 0, y: 0 });
    const PI = { i: 0, j: 0 };
    expect(plateCentreAtWorldInto(o.x, o.y, PI)).toBe(true);
    expect(Math.hypot(o.x - 5000, o.y + 3000)).toBeLessThan(2000);
  });
});
