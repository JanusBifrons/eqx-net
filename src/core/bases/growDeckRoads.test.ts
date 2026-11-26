/**
 * Base platforms slice 32 — a fenced generated deck base joins its gate
 * roads into one road network inside the fence (`growDeckRoads.ts`).
 * `growDeck.test.ts` re-checks every placement against the player's deck
 * rules; `growDeckFence.test.ts` the ring and that every road is inside it.
 * Every gate's road is on the one network (owner: "Join every gate"); the
 * last two cases each had a lone gate-road stub before (sparse or dense).
 */
import { describe, expect, it } from 'vitest';
import { isConnectorKind, structureHalfExtents } from '../../shared-types/structureKinds.js';
import { HEX_DIRS, pixelToAxialInto } from '../hex/hex.js';
import { DECK_HEX_SIZE, isPlateCentreHex } from '../hex/plates.js';
import { connectorOnRoadHex, isRoadBesideDeckGate } from '../structures/deckGateRoad.js';
import { growBase, type GrownBase } from './growBase.js';
import type { BaseProfile, BaseRole, BaseTier } from './baseProfile.js';

function profile(tier: BaseTier, role: BaseRole): BaseProfile {
  const wealth = { outpost: 5_000, settlement: 16_000, stronghold: 50_000, citadel: 120_000 }[tier];
  return { tier, role, ownerFaction: 'traders', wealth, levelCap: tier === 'citadel' ? 5 : 2, fenced: true };
}

const FEATURES = ['asteroid', 'nebula', 'minerals'] as const;
const CASES: Array<[BaseTier, BaseRole, number]> = [
  ['outpost', 'mining', 1], ['outpost', 'mining', 99], ['settlement', 'refinery', 7], ['settlement', 'trade', 3],
  ['stronghold', 'military', 42], ['citadel', 'workshop', 1234],
  ['stronghold', 'trade', 1], ['stronghold', 'workshop', 5],
];
const hk = (q: number, r: number): string => `${q},${r}`;
const hexKey = (x: number, y: number): string => {
  const h = pixelToAxialInto(x, y, DECK_HEX_SIZE, { q: 0, r: 0 });
  return hk(h.q, h.r);
};

/** Road hexes, and the road hex beside each gate. */
function roadsOf(b: GrownBase): { roads: Set<string>; gateRoads: string[] } {
  const roads = new Set<string>();
  for (const p of b.placements) if (p.kind === 'road') {
    const k = hexKey(p.x, p.y);
    expect(roads.has(k), `one road on hex ${k}`).toBe(false);
    roads.add(k);
  }
  const gateRoads = b.placements.filter((g) => g.kind === 'shield_gate').map((g) => {
    const r = b.placements.find((p) => isRoadBesideDeckGate(p.kind, p.x, p.y, g.x, g.y, g.rot ?? 0))!;
    return hexKey(r.x, r.y);
  });
  return { roads, gateRoads };
}

/** Road hexes reached from `from` over bordering road hexes. */
function reach(roads: ReadonlySet<string>, from: string): Set<string> {
  const seen = new Set([from]);
  const q = [from];
  while (q.length) {
    const [hq, hr] = q.pop()!.split(',').map(Number) as [number, number];
    for (const d of HEX_DIRS) {
      const k = hk(hq + d.q, hr + d.r);
      if (roads.has(k) && !seen.has(k)) { seen.add(k); q.push(k); }
    }
  }
  return seen;
}

describe('deck base roads between the gates (base platforms 32)', () => {
  for (const dense of [false, true]) for (const [tier, role, seed] of CASES) {
    const label = `${dense ? 'dense ' : ''}${tier} ${role} #${seed}`;
    it(`${label}: roads on open floor, turned along the deck, every gate joined`, () => {
      const b = growBase(profile(tier, role), seed, [...FEATURES], dense ? { deck: true, dense: true } : { deck: true });
      const { roads, gateRoads } = roadsOf(b);
      // A road shares its hex with nothing but the fence on its seams.
      for (const p of b.placements) {
        if (p.kind === 'road' || p.kind === 'shield_pylon' || p.kind === 'shield_gate') continue;
        if (isConnectorKind(p.kind)) {
          // Roads can't go through a connector: no pylon anywhere in a road's hex.
          const e = structureHalfExtents(p.kind, p.rot ?? 0);
          for (const r of b.placements) if (r.kind === 'road') expect(connectorOnRoadHex(p.x, p.y, e.hw, e.hh, r.x, r.y), `${p.kind} in road hex ${hexKey(r.x, r.y)}`).toBe(false);
          continue;
        }
        expect(roads.has(hexKey(p.x, p.y)), `${p.kind} on a road hex`).toBe(false);
      }
      for (const k of roads) {
        const [q, r] = k.split(',').map(Number) as [number, number];
        expect(isPlateCentreHex(q, r), `road ${k} off the anchor's yard`).toBe(false);
      }
      for (const p of b.placements) if (p.kind === 'road') expect([30, 90, 150]).toContain(p.rot);
      // A road takes no cable (base platforms 34): no edge ends on one.
      for (const [i, j] of b.edges) expect([b.placements[i]!.kind, b.placements[j]!.kind], 'cable on a road').not.toContain('road');
      // Every road is part of the network: it reaches a gate.
      const fromGates = new Set<string>();
      for (const g of gateRoads) for (const k of reach(roads, g)) fromGates.add(k);
      expect(fromGates.size, 'no stray road').toBe(roads.size);
      const joined = gateRoads.length === 0 ? 0 : Math.max(...gateRoads.map((g) => gateRoads.filter((o) => reach(roads, g).has(o)).length));
      console.log(`${label}: ${b.fenceGates} gates, ${roads.size} roads, ${joined} gates on one network`);
      expect(gateRoads.length, 'a road beside every gate').toBe(b.fenceGates);
      expect(b.fenceGates, 'gates').toBeGreaterThanOrEqual(2);
      expect(joined, 'every gate on one road network').toBe(gateRoads.length);
    });
  }

  it('is deterministic per seed (sparse and dense)', () => {
    const p = profile('citadel', 'workshop');
    const roads = (g: GrownBase): unknown => g.placements.filter((q) => q.kind === 'road');
    expect(roads(growBase(p, 1234, [], { deck: true }))).toEqual(roads(growBase(p, 1234, [], { deck: true })));
    expect(roads(growBase(p, 1234, [], { deck: true, dense: true }))).toEqual(roads(growBase(p, 1234, [], { deck: true, dense: true })));
  });
});
