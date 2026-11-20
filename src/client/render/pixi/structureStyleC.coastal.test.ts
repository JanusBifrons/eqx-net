/**
 * Style C coastal family (docs/plans/structure-restyle-stage4.md §6): the
 * seven coastal gun BASES. Each has a drawer, its art stays in the footprint
 * outline, the gun's barbette ring sits in the shared pad's dark well with a
 * lip and nothing drawn after covers it, the trim goes dead unpowered, the
 * family's bake key moved on, and the other gunPad callers are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildStructureVisual } from './structureVisuals.js';
import { structureStyleDrawer, structureStyleVersion } from './structureStyles.js';
import { RIVET, SOOT, insidePoly, outlinePx, polyEdgeDist } from './structureStyleKit.js';
import { STYLE_C_FAMILIES } from './structureStyleC.js';
import { COASTAL_WELL, SIEGE_HALF_W, kinds, version } from './structureStyleC.coastal.js';
import { TRIM, TRIM_DEAD } from './structureStyleC.turrets.pad.js';
import { structureTurrets } from '../art/turretLayout.js';
import { structureTurretRadius } from '../../../core/combat/muzzle.js';
import { COASTAL_DEFENCE_KINDS } from '../../../shared-types/structureKinds/coastal.js';

const sha = (id: string, live: boolean): string => {
  const v = buildStructureVisual(id, { accent: 0x66ccaa, style: 'c', livery: true, powered: live });
  return createHash('sha1').update(JSON.stringify([v.polys, v.lights, v.sigils, v.bands])).digest('hex');
};

describe('coastal: style C gun bases on the shared pad', () => {
  it('every coastal kind has a style C drawer in the coastal family', () => {
    expect(Object.keys(kinds).sort()).toEqual([...COASTAL_DEFENCE_KINDS].sort());
    for (const id of COASTAL_DEFENCE_KINDS) {
      expect(typeof kinds[id], id).toBe('function');
      expect(STYLE_C_FAMILIES.coastal.kinds[id], id).toBe(kinds[id]);
      expect(structureStyleDrawer('c', id), id).toBe(kinds[id]);
    }
  });

  it('the family version is set and rides every coastal bake key', () => {
    expect(version).not.toBe('');
    for (const id of COASTAL_DEFENCE_KINDS) expect(structureStyleVersion('c', id), id).toBe(version);
  });

  it('art stays inside the footprint outline, powered and unpowered, with livery', () => {
    for (const id of COASTAL_DEFENCE_KINDS) {
      for (const live of [true, false]) {
        const v = buildStructureVisual(id, { accent: 0x66ccaa, style: 'c', livery: true, powered: live });
        expect(v.polys!.length, id).toBeGreaterThan(40);
        const out = outlinePx(id, 'c');
        for (const p of v.polys!) for (const [x, y] of p.pts) expect(polyEdgeDist(out, x, y), `${id} ${x},${y}`).toBeGreaterThan(-0.5);
        for (const l of v.lights) expect(insidePoly(out, l.x, l.y), id).toBe(true);
        for (const s of v.sigils ?? []) expect(polyEdgeDist(out, s.x, s.y), id).toBeGreaterThan(s.r);
        expect(v.polys!.some((p) => p.mat === 'hazard'), `${id} hazard`).toBe(true);
      }
    }
  });

  it('the dark well is at least the gun barbette ring, and no later art covers the ring', () => {
    for (const id of COASTAL_DEFENCE_KINDS) {
      const R = structureTurretRadius(id);
      const ring = structureTurrets(id)[0]!.ring;
      expect(COASTAL_WELL[id]! * R, id).toBeGreaterThanOrEqual(ring + 0.04 * R);
      const polys = buildStructureVisual(id, { accent: 0x66ccaa, style: 'c' }).polys!;
      // The well is the LAST soot plate round the centre (the pad draws it last).
      const well = polys.findLastIndex((p) => p.color === SOOT && p.mat === 'metal' && insidePoly(p.pts, 0, 0));
      expect(well, id).toBeGreaterThan(0);
      const pts = polys[well]!.pts;
      if (id === 'siege_gun_80cm') {
        // Cut to the carriage: its full width across, past the ring along it.
        expect(Math.max(...pts.map(([x]) => Math.abs(x))), id).toBeCloseTo(SIEGE_HALF_W * R, 3);
        expect(Math.max(...pts.map(([, y]) => Math.abs(y))), id).toBeGreaterThan(ring);
      } else {
        // A 16-gon: its flats are still outside the ring.
        expect(Math.min(...pts.map(([x, y]) => Math.hypot(x, y))) * Math.cos(Math.PI / 16), id).toBeGreaterThan(ring);
      }
      for (const p of polys.slice(well + 1)) {
        for (const [x, y] of p.pts) expect(Math.hypot(x, y), `${id} ${x},${y}`).toBeGreaterThan(ring);
      }
    }
  });

  it('power off draws dead trim glass and casts no light; power on lights the trim', () => {
    for (const id of COASTAL_DEFENCE_KINDS) {
      const on = buildStructureVisual(id, { accent: 0x66ccaa, style: 'c', powered: true });
      const off = buildStructureVisual(id, { accent: 0x66ccaa, style: 'c', powered: false });
      expect(on.polys!.some((p) => p.mat === 'glow' && p.color === TRIM), id).toBe(true);
      expect(on.lights.length, id).toBeGreaterThan(0);
      expect(off.polys!.some((p) => p.mat === 'glow' && p.color === TRIM_DEAD), id).toBe(true);
      expect(off.polys!.some((p) => p.mat === 'glow' && p.color === TRIM), id).toBe(false);
      expect(off.lights, id).toHaveLength(0);
    }
  });

  it('casemates have an embrasure sill on the firing side (-y); the siege gun runs on four rails', () => {
    for (const id of ['coastal_casemate_8in', 'coastal_lindemann']) {
      const R = structureTurretRadius(id), hh = Math.max(...outlinePx(id, 'c').map(([, y]) => y));
      const polys = buildStructureVisual(id, { accent: 0x66ccaa, style: 'c' }).polys!;
      expect(polys.some((p) => p.mat === 'hazard' && p.pts.every(([x, y]) => y < -hh + 0.12 * R && Math.abs(x) < 0.5 * R)), id).toBe(true);
    }
    const id = 'siege_gun_80cm', L = 450;
    const rails = buildStructureVisual(id, { accent: 0x66ccaa, style: 'c' }).polys!
      .filter((p) => p.color === RIVET && Math.max(...p.pts.map(([, y]) => y)) - Math.min(...p.pts.map(([, y]) => y)) > 1.6 * L);
    expect(rails).toHaveLength(4);
  });

  it('the turrets family gunPad callers draw exactly as before', () => {
    const before: Record<string, readonly [string, string]> = {
      turret: ['deede322ba48c4c861bf64f0989307d47a9f1c51', 'eb388ab718c44d98ae66b419e8022282a2c881f1'],
      laser_bolt_turret: ['44a0d9a9546bd3067f4f0e18c118c75ff4e9fa17', '525dfce1cedb70a558eef34ed742fafefd7ba348'],
      autocannon_turret: ['027b7d06086609938081f98229fb31b99fe2fd7e', 'abce5ac9ac897e23faf35551995457ec9d1ff0aa'],
      missile_turret: ['8d63370d1534188164b598e1cb8751b8cdd2233f', 'f168f3718c8725391d5f888510f030887edbd65c'],
      mine_layer: ['154897674140de74dbfcbec80cda275d2d38e905', '75730d41c093ec0e17d39c72814242a604c5a569'],
    };
    for (const [id, [on, off]] of Object.entries(before)) {
      expect(sha(id, true), `${id} powered`).toBe(on);
      expect(sha(id, false), `${id} unpowered`).toBe(off);
    }
  });
});
