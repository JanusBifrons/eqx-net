/**
 * Base platforms slice 18 — small buildings face their third of the hex. The
 * shared snap (`snapPlacementToDeck`, run by both the client ghost and the
 * server) turns a small-slot building so its footprint's long side lies along
 * its rhombus's long diagonal (corner 2k → corner 2k+2): 0 / 120 / 240°, plus
 * 90° for a footprint taller than wide. The player's own turn is ignored
 * there; quarter-turn-only kinds take the nearest quarter. Other slots keep
 * the player's turn (deck rule).
 */
import { describe, it, expect } from 'vitest';
import { snapPlacementToDeck } from './deckPlacement.js';
import { DECK_FENCE_GATE_KIND, DECK_FENCE_POST_KIND } from './deckLinks.js';
import { rhombusCentroidInto, rhombusFacingDeg, snapToDeckSlot, type DeckSnap } from '../hex/deckSnap.js';
import { hexCornerInto } from '../hex/hex.js';
import { DECK_HEX_SIZE, deckHexCentreInto, isPlateCentreHex, plateCentreWorldInto } from '../hex/plates.js';
import { STRUCTURE_KINDS_LIST } from '../../shared-types/structureKinds/catalogueOrder.js';
import { isStructureQuarterTurnOnly, normaliseStructureQuarterTurn, snapPlayerStructureRotation } from '../../shared-types/structureKinds.js';

const out = (): DeckSnap => ({ x: 0, y: 0, q: 0, r: 0, rhombus: -1, slot: 'small', rot: -1 });
// The fence post snaps to a hex corner instead (slice 19, `deckFence.test.ts`),
// the fence gate to a seam's midpoint (slice 21, `deckGate.test.ts`).
const SMALL = STRUCTURE_KINDS_LIST.filter((k) => k.deckSlot === 'small' && k.id !== DECK_FENCE_POST_KIND && k.id !== DECK_FENCE_GATE_KIND && k.id !== 'connector'); // the Deck plate always lays a plate
/** Hexes (not plate centres) to sample. */
const HEXES: Array<[number, number]> = [];
for (let q = -3; q <= 3; q++) for (let r = -3; r <= 3; r++) if (!isPlateCentreHex(q, r)) HEXES.push([q, r]);

/** Direction (deg, mod 180) of rhombus k's long diagonal, from the corners. */
function longDiagonalDeg(k: number): number {
  const a = { x: 0, y: 0 }, b = { x: 0, y: 0 };
  hexCornerInto(0, 0, DECK_HEX_SIZE, 2 * k, a);
  hexCornerInto(0, 0, DECK_HEX_SIZE, (2 * k + 2) % 6, b);
  const d = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return ((Math.round(d) % 180) + 180) % 180;
}

/** A point inside rhombus k of hex (q, r), off the centroid. */
function pointIn(q: number, r: number, k: number): { x: number; y: number } {
  const c = deckHexCentreInto(q, r, { x: 0, y: 0 });
  const p = rhombusCentroidInto(c.x, c.y, k, { x: 0, y: 0 });
  return { x: p.x + 0.15 * (p.x - c.x) + 7, y: p.y + 0.15 * (p.y - c.y) - 5 };
}

describe('small building facing (slice 18)', () => {
  it('the core snap faces each of the 3 rhombi along its long diagonal (0 / 120 / 240°)', () => {
    expect([0, 1, 2].map(rhombusFacingDeg)).toEqual([0, 120, 240]);
    for (const [q, r] of HEXES) {
      for (let k = 0; k < 3; k++) {
        const { x, y } = pointIn(q, r, k);
        const s = snapToDeckSlot('small', x, y, out());
        expect(s.rhombus).toBe(k);
        expect(s.rot).toBe(rhombusFacingDeg(k));
        expect(s.rot % 180).toBe(longDiagonalDeg(k));
      }
    }
    expect(snapToDeckSlot('hex', 10, 10, out()).rot).toBe(-1);
    expect(snapToDeckSlot('plate', 10, 10, out()).rot).toBe(-1);
  });

  it.each(SMALL.map((k) => [k.id, k] as const))('%s: long side along the rhombus, whatever the player turned', (id, kind) => {
    const tall = kind.footprint.h > kind.footprint.w;
    for (const [q, r] of HEXES.slice(0, 6)) {
      for (let k = 0; k < 3; k++) {
        const { x, y } = pointIn(q, r, k);
        const want = rhombusFacingDeg(k) + (tall ? 90 : 0);
        for (const playerRot of [0, 30, 90, 150, 270]) {
          const s = snapPlacementToDeck(id, x, y, out(), playerRot);
          expect(s.slot).toBe('small');
          if (isStructureQuarterTurnOnly(id)) {
            expect(s.rot, `${id} rhombus ${k}`).toBe(normaliseStructureQuarterTurn(want));
          } else {
            expect(s.rot, `${id} rhombus ${k}`).toBe(want % 360);
            // The footprint's long axis (local x, or y when tall) points along the diagonal.
            const axis = (s.rot + (tall ? 90 : 0)) % 180;
            expect(axis).toBe(longDiagonalDeg(k));
          }
        }
      }
    }
  });

  it('idempotent: re-snapping a snapped small building keeps point and turn', () => {
    for (const kind of SMALL) {
      const { x, y } = pointIn(2, -1, 1);
      const a = snapPlacementToDeck(kind.id, x, y, out(), 60);
      const b = snapPlacementToDeck(kind.id, a.x, a.y, out(), a.rot);
      expect(b).toEqual(a);
    }
  });

  it('a hex building keeps the player turn (30° deck steps; quarters for quarter-turn-only)', () => {
    for (const kind of ['reactor', 'teleporter'] as const) {
      for (const playerRot of [0, 30, 60, 95, 330]) {
        const s = snapPlacementToDeck(kind, 137, -412, out(), playerRot);
        expect(s.rot).toBe(snapPlayerStructureRotation(playerRot, true, kind));
      }
    }
  });

  it('a connector laying a plate keeps the player turn', () => {
    const c = plateCentreWorldInto(1, 0, { x: 0, y: 0 });
    const s = snapPlacementToDeck('connector', c.x + 100, c.y + 50, out(), 60);
    expect(s.slot).toBe('plate');
    expect(s.rot).toBe(60);
  });
});
