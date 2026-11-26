/**
 * Base platforms slice 26 — a fenced generated deck base rings itself: posts
 * on every corner of the inside plates' outer boundary, a wall or a gate on
 * every boundary seam (a closed ring), road gates, and its guns outside the
 * ring on bastion plates. `growDeck.test.ts` re-checks every placement and
 * link against the player's deck rules (fenced cases included).
 */
import { describe, expect, it } from 'vitest';
import { HEX_DIRS, pixelToAxialInto, type AxialHex } from '../hex/hex.js';
import { DECK_HEX_SIZE, deckHexCentreInto, plateOfHexInto } from '../hex/plates.js';
import { isDeckSeam, isDeckSeamEnd, isOnDeckCorner } from '../hex/deckCorners.js';
import { PlateSet } from '../hex/plateSet.js';
import { placementRejection } from '../structures/placementRules.js';
import { isRoadBesideDeckGate } from '../structures/deckGateRoad.js';
import { growBase, TURRET_KINDS, type GrownBase } from './growBase.js';
import type { BaseProfile, BaseRole, BaseTier } from './baseProfile.js';

function profile(tier: BaseTier, role: BaseRole, fenced = true): BaseProfile {
  const wealth = { outpost: 5_000, settlement: 16_000, stronghold: 50_000, citadel: 120_000 }[tier];
  return { tier, role, ownerFaction: 'traders', wealth, levelCap: tier === 'citadel' ? 5 : 2, fenced };
}

const FEATURES = ['asteroid', 'nebula', 'minerals'] as const;
const CASES: Array<[BaseTier, BaseRole, number]> = [
  ['outpost', 'mining', 1], ['settlement', 'refinery', 7], ['stronghold', 'military', 42], ['citadel', 'workshop', 1234],
];
const hk = (q: number, r: number): string => `${q},${r}`;
/** A seam's key: its midpoint, rounded. */
const sk = (x: number, y: number): string => `${Math.round(x)},${Math.round(y)}`;

/** The hex holding a world point. */
function hexOf(x: number, y: number): AxialHex {
  return pixelToAxialInto(x, y, DECK_HEX_SIZE, { q: 0, r: 0 });
}

/** Seams the fence covers (walls between two posts, gates on theirs). */
function fencedSeams(b: GrownBase): Set<string> {
  const out = new Set<string>();
  for (const [i, j] of b.edges) {
    const p = b.placements[i]!, q = b.placements[j]!;
    if (p.kind === 'shield_pylon' && q.kind === 'shield_pylon') {
      expect(isDeckSeam(p.x, p.y, q.x, q.y), `wall ${i}-${j} on a seam`).toBe(true);
      out.add(sk((p.x + q.x) / 2, (p.y + q.y) / 2));
    }
  }
  for (const g of b.placements) if (g.kind === 'shield_gate') out.add(sk(g.x, g.y));
  return out;
}

/** Hexes reachable from the Capital's hex without crossing the fence, out to
 *  `reach` steps (a closed ring keeps it bounded). */
function insideHexes(b: GrownBase, fenced: Set<string>, reach: number): { inside: Set<string>; escaped: boolean } {
  const cap = b.placements.find((p) => p.kind === 'capital')!;
  const start = hexOf(cap.x, cap.y);
  const inside = new Set([hk(start.q, start.r)]);
  const q: AxialHex[] = [start];
  const c = { x: 0, y: 0 }, n = { x: 0, y: 0 };
  let escaped = false;
  while (q.length) {
    const h = q.pop()!;
    deckHexCentreInto(h.q, h.r, c);
    for (const d of HEX_DIRS) {
      const o = { q: h.q + d.q, r: h.r + d.r };
      if (inside.has(hk(o.q, o.r))) continue;
      deckHexCentreInto(o.q, o.r, n);
      if (fenced.has(sk((c.x + n.x) / 2, (c.y + n.y) / 2))) continue;
      if (Math.abs(o.q) + Math.abs(o.r) > reach) { escaped = true; continue; }
      inside.add(hk(o.q, o.r));
      q.push(o);
    }
  }
  return { inside, escaped };
}

describe('fenced deck base: a closed seam ring with road gates (base platforms 26)', () => {
  for (const dense of [false, true]) for (const [tier, role, seed] of CASES) {
    it(`${dense ? 'dense ' : ''}${tier} ${role}: ring closed, gates on roads, guns outside`, () => {
      const b = growBase(profile(tier, role), seed, [...FEATURES], dense ? { deck: true, dense: true } : { deck: true });
      const posts = b.placements.filter((p) => p.kind === 'shield_pylon');
      const gates = b.placements.filter((p) => p.kind === 'shield_gate');
      expect(posts).toHaveLength(b.fencePylons);
      expect(gates).toHaveLength(b.fenceGates);
      expect(gates.length).toBeGreaterThanOrEqual(1);
      const fenced = fencedSeams(b);
      const { inside, escaped } = insideHexes(b, fenced, 80);
      expect(escaped, 'the ring is closed').toBe(false);
      // Inside = whole plates (the ring follows plate edges): every inside hex
      // is on a laid plate, and every hex of an inside plate is inside.
      const plates = new PlateSet<number>();
      b.placements.forEach((p, i) => plates.upsert(i, 'o', p.kind, p.x, p.y));
      const pi = { i: 0, j: 0 };
      const insidePlates = new Set<string>();
      for (const k of inside) {
        const [q, r] = k.split(',').map(Number) as [number, number];
        plateOfHexInto(q, r, pi);
        expect(plates.hasPlate('o', pi.i, pi.j), `inside hex ${k} on a laid plate`).toBe(true);
        insidePlates.add(hk(pi.i, pi.j));
      }
      // Every boundary seam of the inside plates is fenced (and nothing else).
      const c = { x: 0, y: 0 }, n = { x: 0, y: 0 };
      let boundary = 0;
      for (const k of inside) {
        const [q, r] = k.split(',').map(Number) as [number, number];
        deckHexCentreInto(q, r, c);
        for (const d of HEX_DIRS) {
          plateOfHexInto(q + d.q, r + d.r, pi);
          deckHexCentreInto(q + d.q, r + d.r, n);
          const seam = sk((c.x + n.x) / 2, (c.y + n.y) / 2);
          if (insidePlates.has(hk(pi.i, pi.j))) { expect(fenced.has(seam), `inner seam ${seam} unfenced`).toBe(false); continue; }
          boundary++;
          expect(fenced.has(seam), `boundary seam ${seam} fenced`).toBe(true);
        }
      }
      expect(fenced.size).toBe(boundary);
      // Every post on a corner of the boundary: one inside hex, one outside.
      for (const p of posts) {
        expect(isOnDeckCorner(p.x, p.y)).toBe(true);
        let ins = 0;
        for (let a = 0; a < 6; a++) {
          const h = hexOf(p.x + 200 * Math.cos((a * Math.PI) / 3 + Math.PI / 6), p.y + 200 * Math.sin((a * Math.PI) / 3 + Math.PI / 6));
          if (inside.has(hk(h.q, h.r))) ins++;
        }
        expect(ins > 0 && ins < 6, `post (${p.x}, ${p.y}) on the boundary`).toBe(true);
      }
      // Each gate: links to the two posts on its seam's ends, and has its road
      // on the inside hex (the player's 'no-road' rule passes).
      b.placements.forEach((g, gi) => {
        if (g.kind !== 'shield_gate') return;
        const ends = b.edges.filter(([i, j]) => i === gi || j === gi).map(([i, j]) => b.placements[i === gi ? j : i]!);
        expect(ends).toHaveLength(2);
        for (const e of ends) expect(e.kind === 'shield_pylon' && isDeckSeamEnd(e.x, e.y, g.x, g.y)).toBe(true);
        const road = b.placements.find((r) => isRoadBesideDeckGate(r.kind, r.x, r.y, g.x, g.y, g.rot ?? 0));
        expect(road, 'gate has its road').toBeDefined();
        const rh = hexOf(road!.x, road!.y);
        expect(inside.has(hk(rh.q, rh.r)), 'road inside').toBe(true);
      });
      // Guns outside the ring (a fence blocks its own side's shots); every
      // other building inside.
      let guns = 0;
      for (const p of b.placements) {
        if (p.kind === 'shield_pylon' || p.kind === 'shield_gate') continue;
        const h = hexOf(p.x, p.y);
        const isGun = TURRET_KINDS.has(p.kind);
        if (isGun) guns++;
        if (p.kind === 'connector') continue; // bastion plates' anchors stand outside
        expect(inside.has(hk(h.q, h.r)), `${p.kind} ${isGun ? 'outside' : 'inside'}`).toBe(!isGun);
      }
      expect(guns).toBeGreaterThan(0);
      expect(b.netPower).toBeGreaterThanOrEqual(0);
    });
  }

  it('is deterministic per seed (sparse and dense)', () => {
    const p = profile('stronghold', 'military');
    expect(growBase(p, 42, [], { deck: true })).toEqual(growBase(p, 42, [], { deck: true }));
    expect(growBase(p, 42, [], { deck: true, dense: true })).toEqual(growBase(p, 42, [], { deck: true, dense: true }));
  });

  it('unfenced deck bases lay no fence, road or bastion', () => {
    for (const dense of [false, true]) {
      const b = growBase(profile('settlement', 'trade', false), 9, [...FEATURES], { deck: true, dense });
      expect(b.placements.some((p) => p.kind === 'shield_pylon' || p.kind === 'shield_gate' || p.kind === 'road')).toBe(false);
    }
  });
});

describe('deck rule: a fence on the deck\'s outer seam stands on the deck (base platforms 26)', () => {
  it('every corner and edge midpoint round a lone plate passes, one hex further out is off-deck', () => {
    const plates = new PlateSet<number>();
    plates.upsert(0, 'o', 'connector', 0, 0);
    const deck = { plates, owner: 'o' };
    const c = { x: 0, y: 0 };
    let checked = 0;
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
      deckHexCentreInto(i, j, c);
      if (!plates.plateAtWorld('o', c.x, c.y)) continue;
      for (let e = 0; e < 6; e++) {
        const a0 = Math.PI / 6 + (e * Math.PI) / 3, a1 = a0 + Math.PI / 3;
        const ax = c.x + DECK_HEX_SIZE * Math.cos(a0), ay = c.y + DECK_HEX_SIZE * Math.sin(a0);
        const bx = c.x + DECK_HEX_SIZE * Math.cos(a1), by = c.y + DECK_HEX_SIZE * Math.sin(a1);
        expect(placementRejection('shield_pylon', ax, ay, [], null, 0, undefined, deck)).toBeNull();
        const dir = (((e * 60 + 90) % 180) + 180) % 180;
        // Gates need a road: here only the deck standing is checked.
        expect(placementRejection('shield_gate', (ax + bx) / 2, (ay + by) / 2, [], null, dir, undefined, deck)).not.toBe('off-deck');
        checked++;
      }
    }
    expect(checked).toBe(42);
    // A post a whole hex off the plate is still off the deck.
    expect(placementRejection('shield_pylon', 0, 4 * DECK_HEX_SIZE, [], null, 0, undefined, deck)).toBe('off-deck');
  });
});
