/** The Shipyard's "build frame" rig (`shipyard-frame`, rigs/heavyIndustry.ts):
 *  its named parts and joints, that it adds no collider, that every part
 *  stays inside the style C footprint outline at rest and across the whole
 *  scrubbed build clip, and that the slipway fits every sub-cap the yard
 *  builds. */
import { describe, expect, it } from 'vitest';
import { RECIPES, recipesFor } from '../../shared-types/recipes.js';
import { SHIP_KINDS } from '../../shared-types/shipKinds.js';
import { structureOutline } from '../../shared-types/structureKinds/outline.js';
import { createRigPose, evaluateRig } from './evaluate.js';
import { JOINT_HINGE, JOINT_LIFT, JOINT_SLIDE, rigPartIndex } from './rig.js';
import { rigById, rigForStructureKind } from './rigCatalogue.js';
import {
  SHIPYARD_BUILD_TICKS, SHIPYARD_CLAMP_LEN, SHIPYARD_CLAMP_Y, SHIPYARD_SLIP_HALF_W, SHIPYARD_SLIP_X0, SHIPYARD_SLIP_X1,
  shipyardBuildPlaying,
} from './rigs/heavyIndustry.js';

const rig = rigById('shipyard-frame')!;
const KINDS = SHIP_KINDS as Readonly<Record<string, { readonly radius: number; readonly sizeClass?: string }>>;

const JOINTS: Readonly<Record<string, number>> = {
  ...Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [`light-${i}`, JOINT_HINGE])),
  ...Object.fromEntries([0, 1, 2, 3].flatMap((i) => [[`clamp-port-${i}`, JOINT_HINGE], [`clamp-stbd-${i}`, JOINT_HINGE]])),
  'wall-port': JOINT_SLIDE, 'wall-stbd': JOINT_SLIDE, gantry: JOINT_SLIDE, 'gantry-hoist': JOINT_LIFT,
};

/** Even-odd point-in-polygon. */
function inside(poly: readonly { x: number; y: number }[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

describe('shipyard build frame rig', () => {
  it('is the Shipyard rig, with the named parts and joint types', () => {
    expect(rigForStructureKind('shipyard')).toBe(rig);
    const got: Record<string, number> = {};
    for (let i = 0; i < rig.partCount; i++) got[rig.partIds[i]!] = rig.jointType[i]!;
    expect(got).toEqual(JOINTS);
    // Lights are locked (static, lit in order later); the hoist rides the gantry.
    for (let i = 0; i < 6; i++) expect(rig.max[rigPartIndex(rig, `light-${i}`)]).toBe(0);
    expect(rig.parent[rigPartIndex(rig, 'gantry-hoist')]).toBe(rigPartIndex(rig, 'gantry'));
  });

  it('adds no collider: every part is a cosmetic over part', () => {
    for (const p of rig.parts) {
      expect(p.layer, p.id).toBe('over');
      expect(p.kind, p.id).toBe('cosmetic');
    }
  });

  it('every part stays inside the style C footprint outline, at rest and across the build', () => {
    const outline = structureOutline('shipyard', 'c');
    const pose = createRigPose(rig);
    const playing = { clipId: '', startTick: 0 };
    const now = 10_000;
    for (let s = -1; s <= 40; s++) {
      evaluateRig(rig, s < 0 ? null : shipyardBuildPlaying(s / 40, now, playing), now, pose);
      for (let i = 0; i < rig.partCount; i++) {
        const o = rig.parts[i]!.outline!;
        const c = pose.cos[i]!, sn = pose.sin[i]!;
        for (let k = 0; k < o.length; k += 2) {
          const px = o[k]!, py = o[k + 1]!;
          const x = pose.x[i]! + px * c - py * sn, y = pose.y[i]! + px * sn + py * c;
          expect(inside(outline, x, y), `${rig.partIds[i]} at step ${s}: (${x.toFixed(0)}, ${y.toFixed(0)})`).toBe(true);
        }
      }
    }
  });

  it('rests with no clip, and progress 0 is the rest pose', () => {
    const a = createRigPose(rig), b = createRigPose(rig);
    evaluateRig(rig, null, 500, a);
    evaluateRig(rig, shipyardBuildPlaying(0, 500, { clipId: '', startTick: 0 }), 500, b);
    for (let i = 0; i < rig.partCount; i++) {
      expect(a.value[i], rig.partIds[i]).toBeCloseTo(rig.rest[i]!, 9);
      expect(b.value[i], rig.partIds[i]).toBeCloseTo(rig.rest[i]!, 9);
    }
  });

  it('scrubs: mid-build the clamps are in and the hoist up; at the end the walls are open', () => {
    const pose = createRigPose(rig), playing = { clipId: '', startTick: 0 };
    evaluateRig(rig, shipyardBuildPlaying(0.4, 1000, playing), 1000, pose);
    expect(pose.value[rigPartIndex(rig, 'clamp-port-0')]).toBeCloseTo(-Math.PI / 2, 6);
    expect(pose.value[rigPartIndex(rig, 'clamp-stbd-3')]).toBeCloseTo(Math.PI / 2, 6);
    expect(pose.value[rigPartIndex(rig, 'gantry-hoist')]).toBeCloseTo(1, 6);
    evaluateRig(rig, shipyardBuildPlaying(1, 1000, playing), 1000, pose);
    expect(pose.value[rigPartIndex(rig, 'wall-port')]).toBeCloseTo(rig.max[rigPartIndex(rig, 'wall-port')]!, 6);
    expect(playing.startTick).toBe(1000 - SHIPYARD_BUILD_TICKS);
    // Progress is clamped to 0..1.
    expect(shipyardBuildPlaying(3, 1000, playing).startTick).toBe(1000 - SHIPYARD_BUILD_TICKS);
    expect(shipyardBuildPlaying(-1, 1000, playing).startTick).toBe(1000);
  });

  it('the slipway fits every sub-cap the yard builds, clear of the swung-in clamps', () => {
    const hulls = recipesFor('shipyard').flatMap((id) => RECIPES[id].outputs.flatMap((o) => ('hull' in o ? [o.hull] : [])));
    expect(hulls.length).toBeGreaterThan(0);
    const subCaps = [...hulls, 'fighter'].filter((h) => KINDS[h]!.sizeClass !== 'capital');
    expect(subCaps).toContain('missile-frigate');
    const tip = SHIPYARD_CLAMP_Y - SHIPYARD_CLAMP_LEN;
    for (const h of subCaps) {
      const r = KINDS[h]!.radius;
      expect(2 * r + 20, h).toBeLessThanOrEqual(2 * SHIPYARD_SLIP_HALF_W);
      expect(2 * r + 20, h).toBeLessThanOrEqual(SHIPYARD_SLIP_X1 - SHIPYARD_SLIP_X0);
      expect(r, `${h} vs clamp tips`).toBeLessThan(tip);
    }
  });
});
