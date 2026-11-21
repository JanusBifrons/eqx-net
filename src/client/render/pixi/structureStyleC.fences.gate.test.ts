/**
 * Style C gatehouses (`structureStyleC.fences.gate.ts`): the shield gate and
 * airlock towers draw for both kinds, leave the opening clear (only flat
 * floor, track and deck lights lie in it), give each door leaf a pocket, bake
 * the deck lights shut (red), and dress the door rig leaves in their own art.
 */
import { describe, it, expect } from 'vitest';
import { buildStructureVisual } from './structureVisuals.js';
import { polyBounds } from './structureStyleKit.js';
import {
  DECK_LIGHT_DEAD, DECK_LIGHT_OPEN, DECK_LIGHT_SHUT, deckLightColor, deckLightStrips, doorLeafContext,
} from './structureStyleC.fences.gate.js';
import { version } from './structureStyleC.fences.js';
import { StructureRigView } from './structureRigs.js';
import { rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import { DOOR_LEAF_THICKNESS } from '../../../core/articulation/rigs/fences.js';
import { AIRLOCK_END_Y, AIRLOCK_OPENING, GATE_OPENING } from '../../../shared-types/structureKinds/gatePosts.js';

const KINDS = [
  { id: 'shield_gate', gap: GATE_OPENING / 2, doors: [0], towers: 2 },
  { id: 'shield_airlock', gap: AIRLOCK_OPENING / 2, doors: [-AIRLOCK_END_Y, AIRLOCK_END_Y], towers: 4 },
] as const;

const draw = (id: string, live = true) => buildStructureVisual(id, { accent: 0x4488ff, style: 'c', livery: true, ...(live ? {} : { powered: false }) });

describe('style C gatehouses', () => {
  it('fences version bumped so cached gate art re-bakes', () => {
    expect(version).not.toBe('f2lb');
  });

  for (const k of KINDS) {
    it(`${k.id}: draws towers, emitters and lamps`, () => {
      const v = draw(k.id);
      expect(v.polys!.length).toBeGreaterThan(30);
      // Tall tower cores (lift 22), one per tower.
      expect(v.polys!.filter((p) => p.lift === 22).length).toBe(k.towers);
      // Every emitter collar (lift 26) and both pocket lips (lift 2) land on the outline.
      expect(v.polys!.filter((p) => p.lift === 26).length).toBe(k.towers);
      expect(v.polys!.filter((p) => p.lift === 2).length).toBe(2 * k.towers);
      expect(v.lights.length).toBeGreaterThan(k.towers);
      expect(v.bands!.length).toBeGreaterThan(0);
    });

    it(`${k.id}: keeps the opening clear (only flat floor, track and lights in it)`, () => {
      const v = draw(k.id);
      const inGap = v.polys!.filter((p) => {
        const b = polyBounds(p.pts);
        return b.x < k.gap - 0.5 && b.x + b.w > -k.gap + 0.5;
      });
      expect(inGap.length).toBeGreaterThan(0);
      for (const p of inGap) expect(p.lift, JSON.stringify(polyBounds(p.pts))).toBeLessThanOrEqual(1);
    });

    it(`${k.id}: a dark pocket in every tower on each door line`, () => {
      const v = draw(k.id);
      const pockets = v.polys!.filter((p) => p.lift === -3);
      expect(pockets.length).toBe(k.towers);
      for (const p of pockets) {
        const b = polyBounds(p.pts);
        // Starts at the opening face and runs into the tower most of a leaf.
        expect(Math.min(Math.abs(b.x), Math.abs(b.x + b.w))).toBeCloseTo(k.gap, 5);
        expect(b.w).toBeGreaterThan(k.gap * 0.85);
        expect(b.h).toBeGreaterThanOrEqual(DOOR_LEAF_THICKNESS);
        expect(k.doors.some((y) => Math.abs(b.y + b.h / 2 - y) < 1e-6)).toBe(true);
      }
    });

    it(`${k.id}: deck lights baked shut (red), clear of the leaves, inside the opening`, () => {
      const strips = deckLightStrips(k.id);
      expect(strips.length).toBe(2 * k.doors.length);
      for (const s of strips) {
        expect(s.x0).toBeGreaterThanOrEqual(-k.gap);
        expect(s.x1).toBeLessThanOrEqual(k.gap);
        for (const y of k.doors) {
          const clear = s.y1 <= y - DOOR_LEAF_THICKNESS / 2 || s.y0 >= y + DOOR_LEAF_THICKNESS / 2;
          expect(clear).toBe(true);
        }
      }
      const red = draw(k.id).polys!.filter((p) => p.mat === 'glow' && p.color === DECK_LIGHT_SHUT);
      expect(red.length).toBe(strips.length);
      const dead = draw(k.id, false).polys!.filter((p) => p.mat === 'glow' && p.color === DECK_LIGHT_DEAD);
      expect(dead.length).toBe(strips.length);
    });

    it(`${k.id}: door leaves draw the armoured leaf art`, () => {
      const rig = rigForStructureKind(k.id)!;
      const view = new StructureRigView(rig);
      expect(view.parts.length).toBe(2 * k.doors.length);
      view.parts.forEach((g, i) => {
        const ctx = doorLeafContext(rig, i);
        expect(ctx).not.toBeNull();
        expect(g.context).toBe(ctx);
      });
    });
  }

  it('deck light: green only when fully open; dark unpowered', () => {
    expect(deckLightColor(false)).toBe(DECK_LIGHT_SHUT);
    expect(deckLightColor(true)).toBe(DECK_LIGHT_OPEN);
    expect(deckLightColor(true, false)).toBe(DECK_LIGHT_DEAD);
    expect(deckLightStrips('shield_pylon')).toEqual([]);
  });
});
