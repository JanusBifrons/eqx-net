/**
 * Style C turrets family, S2 (docs/plans/structure-restyle-stage4.md §6): the
 * beam, bolt and autocannon turret BASES. Each has a drawer, its art stays in
 * the footprint outline, the gun ring (turretLayout.ts) sits in a dark well
 * nothing is drawn over, and the family's bake key moved on.
 */
import { describe, expect, it } from 'vitest';
import { buildStructureVisual } from './structureVisuals.js';
import { structureStyleDrawer, structureStyleVersion } from './structureStyles.js';
import { SOOT, insidePoly, outlinePx, polyEdgeDist } from './structureStyleKit.js';
import { STYLE_C_FAMILIES } from './structureStyleC.js';
import { kinds, version, rigs, TURRET_WELL } from './structureStyleC.turrets.js';
import { structureTurrets } from '../art/turretLayout.js';
import { structureTurretRadius } from '../../../core/combat/muzzle.js';
import { SANDBOX_DOOR_TURRET_DEF } from '../../../core/articulation/rigCatalogue.js';
import { buildRig, rigPartIndex } from '../../../core/articulation/rig.js';
import { rigPartContext } from './structureRigLook.js';

const GUNS = ['turret', 'laser_bolt_turret', 'autocannon_turret'] as const;

describe('turrets S2: style C gun bases', () => {
  it('each of the three guns has a style C drawer', () => {
    for (const id of GUNS) {
      expect(typeof kinds[id], id).toBe('function');
      expect(structureStyleDrawer('c', id), id).toBe(kinds[id]);
    }
  });

  it('the family version is bumped and rides the three kinds\' bake keys', () => {
    expect(version).not.toBe('');
    expect(STYLE_C_FAMILIES.turrets.version).toBe(version);
    for (const id of GUNS) expect(structureStyleVersion('c', id), id).toBe(version);
  });

  it('keeps the beam turret hatch rig hook and adds no other rig', () => {
    expect(Object.keys(rigs)).toEqual([SANDBOX_DOOR_TURRET_DEF.id]);
  });

  it('art stays inside the footprint outline, lit, with livery', () => {
    for (const id of GUNS) {
      for (const live of [true, false]) {
        const v = buildStructureVisual(id, { accent: 0x66ccaa, style: 'c', livery: true, powered: live });
        expect(v.polys!.length, id).toBeGreaterThan(20);
        const out = outlinePx(id, 'c');
        for (const p of v.polys!) for (const [x, y] of p.pts) expect(polyEdgeDist(out, x, y), `${id} ${x},${y}`).toBeGreaterThan(-0.5);
        for (const l of v.lights) expect(insidePoly(out, l.x, l.y), id).toBe(true);
        for (const s of v.sigils ?? []) expect(polyEdgeDist(out, s.x, s.y), id).toBeGreaterThan(s.r);
        expect(v.bands!.length, id).toBeGreaterThan(0);
        expect(v.polys!.some((p) => p.mat === 'glow'), id).toBe(true);
      }
    }
  });

  it('the gun ring sits in a dark well that no later art covers', () => {
    for (const id of GUNS) {
      const R = structureTurretRadius(id);
      const ring = structureTurrets(id)[0]!.ring;
      expect(ring, id).toBeLessThan(TURRET_WELL * R);
      const polys = buildStructureVisual(id, { accent: 0x66ccaa, style: 'c' }).polys!;
      const well = polys.findIndex((p) => p.color === SOOT && insidePoly(p.pts, 0, 0));
      expect(well, id).toBeGreaterThan(0);
      for (const p of polys.slice(well + 1)) {
        for (const [x, y] of p.pts) expect(Math.hypot(x, y), `${id} ${x},${y}`).toBeGreaterThan(ring);
      }
    }
  });

  it('bolt: twin lit capacitor pods on ±x; autocannon: a hazard-striped feed on −y', () => {
    const bolt = buildStructureVisual('laser_bolt_turret', { accent: 0, style: 'c' }).polys!;
    const R = structureTurretRadius('laser_bolt_turret');
    for (const s of [-1, 1]) {
      expect(bolt.filter((p) => p.mat === 'glow' && p.pts.every(([x]) => s * x > 0.6 * R)).length, `side ${s}`).toBeGreaterThanOrEqual(3);
    }
    const ac = buildStructureVisual('autocannon_turret', { accent: 0, style: 'c' }).polys!;
    const hz = ac.filter((p) => p.mat === 'hazard');
    expect(hz.length).toBeGreaterThan(0);
    for (const p of hz) for (const [, y] of p.pts) expect(y).toBeLessThan(0);
  });

  it('the beam turret hatch draws its riser and leaves in the gun-pad armour, cached per part', () => {
    const rig = buildRig(SANDBOX_DOOR_TURRET_DEF);
    const art = rigs[SANDBOX_DOOR_TURRET_DEF.id]!.partArt!;
    for (const id of ['turret-lift', 'door-left', 'door-right']) {
      const i = rigPartIndex(rig, id);
      const ctx = art(rig, i);
      expect(ctx, id).not.toBeNull();
      expect(ctx, id).not.toBe(rigPartContext(rig, i));
      expect(art(rig, i), id).toBe(ctx);
    }
    expect(art(rig, rig.partCount)).toBeNull();
    expect(art(rig, rigPartIndex(rig, 'door-left'))).not.toBe(art(rig, rigPartIndex(rig, 'door-right')));
  });
});
