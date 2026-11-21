/**
 * Style C turrets family, the heavy defences (docs/plans/structure-restyle-
 * stage4.md §6): the missile turret and mine layer BASES. Each has a drawer,
 * its art stays in the footprint outline, the missile launcher ring sits in a
 * dark well nothing is drawn over, the mine layer shows six mine racks, and
 * the family's bake key moved on.
 */
import { describe, expect, it } from 'vitest';
import { buildStructureVisual } from './structureVisuals.js';
import { structureStyleDrawer, structureStyleVersion } from './structureStyles.js';
import { SLAB_LIGHT, SOOT, centroid, insidePoly, outlinePx, polyEdgeDist } from './structureStyleKit.js';
import { STYLE_C_FAMILIES } from './structureStyleC.js';
import { kinds, version, MISSILE_WELL, MINE_LAMP_SOCKETS, RACK_R, RACKS } from './structureStyleC.turretsHeavy.js';
import { TRIM_DEAD } from './structureStyleC.turrets.pad.js';
import * as turrets from './structureStyleC.turrets.js';
import { structureTurrets } from '../art/turretLayout.js';
import { structureTurretRadius } from '../../../core/combat/muzzle.js';

const HEAVY = ['missile_turret', 'mine_layer'] as const;

describe('turrets S3: style C heavy defence bases', () => {
  it('both heavy kinds have a style C drawer, spread through the turrets family', () => {
    for (const id of HEAVY) {
      expect(typeof kinds[id], id).toBe('function');
      expect(turrets.kinds[id], id).toBe(kinds[id]);
      expect(structureStyleDrawer('c', id), id).toBe(kinds[id]);
    }
  });

  it('the heavy version rides both kinds\' bake keys (via the family version)', () => {
    expect(version).not.toBe('');
    expect(turrets.version).toContain(version);
    expect(STYLE_C_FAMILIES.turrets.version).toBe(turrets.version);
    for (const id of HEAVY) expect(structureStyleVersion('c', id), id).toBe(turrets.version);
  });

  it('art stays inside the footprint outline, powered and unpowered, with livery', () => {
    for (const id of HEAVY) {
      for (const live of [true, false]) {
        const v = buildStructureVisual(id, { accent: 0x66ccaa, style: 'c', livery: true, powered: live });
        expect(v.polys!.length, id).toBeGreaterThan(30);
        const out = outlinePx(id, 'c');
        for (const p of v.polys!) for (const [x, y] of p.pts) expect(polyEdgeDist(out, x, y), `${id} ${x},${y}`).toBeGreaterThan(-0.5);
        for (const l of v.lights) expect(insidePoly(out, l.x, l.y), id).toBe(true);
        for (const s of v.sigils ?? []) expect(polyEdgeDist(out, s.x, s.y), id).toBeGreaterThan(s.r);
        expect(v.bands!.length, id).toBeGreaterThan(0);
        expect(v.polys!.some((p) => p.mat === 'glow'), id).toBe(true);
      }
    }
  });

  it('missile: the launcher ring sits in a dark well that no later art covers', () => {
    const id = 'missile_turret';
    const R = structureTurretRadius(id);
    const ring = structureTurrets(id)[0]!.ring;
    expect(ring).toBeLessThan(MISSILE_WELL * R);
    const polys = buildStructureVisual(id, { accent: 0x66ccaa, style: 'c' }).polys!;
    const well = polys.findIndex((p) => p.color === SOOT && p.mat === 'metal' && insidePoly(p.pts, 0, 0));
    expect(well).toBeGreaterThan(0);
    for (const p of polys.slice(well + 1)) {
      for (const [x, y] of p.pts) expect(Math.hypot(x, y), `${x},${y}`).toBeGreaterThan(ring);
    }
    // Blast vents at both pointed ends, a hazard edge on the magazine hatch (+y).
    const hz = polys.filter((p) => p.mat === 'hazard');
    expect(hz.length).toBeGreaterThan(0);
    for (const p of hz) for (const [, y] of p.pts) expect(y).toBeGreaterThan(0.6 * R);
    for (const s of [-1, 1]) {
      expect(polys.some((p) => p.color === SOOT && p.pts.every(([x]) => s * x > 0.75 * R)), `vent ${s}`).toBe(true);
    }
  });

  it('mine layer: no mount, a dark tube mouth in the middle and six mine racks round it', () => {
    const id = 'mine_layer';
    expect(structureTurrets(id)).toEqual([]);
    const R = structureTurretRadius(id);
    const polys = buildStructureVisual(id, { accent: 0xff8a3d, style: 'c' }).polys!;
    expect(polys.some((p) => p.color === SOOT && p.mat === 'metal' && insidePoly(p.pts, 0, 0))).toBe(true);
    const racks = polys.filter((p) => p.color === SLAB_LIGHT && Math.abs(Math.hypot(...centroid(p.pts)) - RACK_R * R) < 0.03 * R);
    expect(racks).toHaveLength(RACKS);
    expect(RACKS).toBe(6);
    // One mine lamp socket per rack, dead glass whether powered or not (a
    // later slice lights them per deployed mine); no light is cast from them.
    expect(MINE_LAMP_SOCKETS).toHaveLength(RACKS);
    for (const live of [true, false]) {
      const v = buildStructureVisual(id, { accent: 0xff8a3d, style: 'c', powered: live });
      for (const [k, [sx, sy]] of MINE_LAMP_SOCKETS.entries()) {
        const near = (p: { pts: readonly (readonly [number, number])[] }) => Math.hypot(centroid(p.pts)[0] - sx * R, centroid(p.pts)[1] - sy * R) < 0.01 * R;
        expect(v.polys!.some((p) => p.mat === 'glow' && p.color === TRIM_DEAD && near(p)), `socket ${k} ${live}`).toBe(true);
        expect(Math.hypot(sx, sy)).toBeGreaterThan(RACK_R);
      }
      expect(v.lights, `${live}`).toHaveLength(live ? 4 : 0);
    }
  });
});
