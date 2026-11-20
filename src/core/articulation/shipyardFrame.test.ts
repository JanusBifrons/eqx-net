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
  SHIPYARD_BUILD_TICKS, SHIPYARD_CLAMP_LEN, SHIPYARD_FIT_STAGES, SHIPYARD_HULL_BLOCK_XS, SHIPYARD_HULL_BLOCKS, SHIPYARD_CLAMP_Y, SHIPYARD_SLIP_HALF_W, SHIPYARD_SLIP_X0, SHIPYARD_SLIP_X1,
  shipyardBuildPlaying,
} from './rigs/heavyIndustry.js';

const rig = rigById('shipyard-frame')!;
const KINDS = SHIP_KINDS as Readonly<Record<string, { readonly radius: number; readonly sizeClass?: string }>>;

const JOINTS: Readonly<Record<string, number>> = {
  keel: JOINT_HINGE,
  ...Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [`light-${i}`, JOINT_LIFT])),
  ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map((j) => [`hull-${j}`, JOINT_LIFT])),
  ...Object.fromEntries(SHIPYARD_FIT_STAGES.map((s) => [`fit-${s}`, JOINT_LIFT])),
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
    // The keel is locked; lights, hull blocks and fittings are 0..1 lifts on
    // it (never a root pop-up riser); the hoist rides the gantry.
    const keel = rigPartIndex(rig, 'keel');
    expect(rig.max[keel]).toBe(0);
    for (const id of rig.partIds) {
      if (!/^(light|hull|fit)-/.test(id)) continue;
      expect(rig.parent[rigPartIndex(rig, id)], id).toBe(keel);
      expect(rig.rest[rigPartIndex(rig, id)], id).toBe(0);
      expect(rig.max[rigPartIndex(rig, id)], id).toBe(1);
    }
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

  it('scrubs: mid-build the clamps are in and the hoist is working; at the end the walls are open', () => {
    const pose = createRigPose(rig), playing = { clipId: '', startTick: 0 };
    evaluateRig(rig, shipyardBuildPlaying(0.4, 1000, playing), 1000, pose);
    expect(pose.value[rigPartIndex(rig, 'clamp-port-0')]).toBeCloseTo(-Math.PI / 2, 6);
    expect(pose.value[rigPartIndex(rig, 'clamp-stbd-3')]).toBeCloseTo(Math.PI / 2, 6);
    const hoist = pose.value[rigPartIndex(rig, 'gantry-hoist')]!;
    expect(hoist).toBeGreaterThan(0.3);
    expect(hoist).toBeLessThanOrEqual(1);
    evaluateRig(rig, shipyardBuildPlaying(1, 1000, playing), 1000, pose);
    expect(pose.value[rigPartIndex(rig, 'wall-port')]).toBeCloseTo(rig.max[rigPartIndex(rig, 'wall-port')]!, 6);
    expect(playing.startTick).toBe(1000 - SHIPYARD_BUILD_TICKS);
    // Progress is clamped to 0..1.
    expect(shipyardBuildPlaying(3, 1000, playing).startTick).toBe(1000 - SHIPYARD_BUILD_TICKS);
    expect(shipyardBuildPlaying(-1, 1000, playing).startTick).toBe(1000);
  });

  it('the sequence order: clamps, then blocks middle-out, then parts, then lights bow-to-stern, then open', () => {
    const pose = createRigPose(rig), playing = { clipId: '', startTick: 0 };
    const v = (id: string) => pose.value[rigPartIndex(rig, id)]!;
    /** First clip tick at which `pred` holds (Infinity: never). */
    const first = new Map<string, number>();
    const mark = (key: string, t: number, on: boolean) => { if (on && !first.has(key)) first.set(key, t); };
    for (let t = 0; t <= SHIPYARD_BUILD_TICKS; t++) {
      evaluateRig(rig, shipyardBuildPlaying(t / SHIPYARD_BUILD_TICKS, 5000, playing), 5000, pose);
      mark('clamps in', t, Math.abs(v('clamp-port-0')) > Math.PI / 2 - 1e-6 && Math.abs(v('clamp-stbd-3')) > Math.PI / 2 - 1e-6);
      for (let j = 0; j < SHIPYARD_HULL_BLOCKS; j++) { mark(`hull-${j} start`, t, v(`hull-${j}`) > 0); mark(`hull-${j} done`, t, v(`hull-${j}`) >= 1); }
      for (const s of SHIPYARD_FIT_STAGES) { mark(`fit-${s} start`, t, v(`fit-${s}`) > 0); mark(`fit-${s} done`, t, v(`fit-${s}`) >= 1); }
      for (let i = 0; i < 6; i++) mark(`light-${i}`, t, v(`light-${i}`) >= 0.5);
      mark('clamps open', t, first.has('clamps in') && Math.abs(v('clamp-port-0')) < Math.PI / 2 - 1e-6);
      mark('walls open', t, v('wall-port') > 0);
    }
    const at = (k: string) => { expect(first.has(k), k).toBe(true); return first.get(k)!; };
    // Blocks print middle-out, alternating bow side and stern side.
    for (let j = 1; j < SHIPYARD_HULL_BLOCKS; j++) {
      const a = SHIPYARD_HULL_BLOCK_XS[j - 1]!, b = SHIPYARD_HULL_BLOCK_XS[j]!;
      expect(Math.abs(b), `block ${j} no nearer the middle`).toBeGreaterThanOrEqual(Math.abs(a));
      expect(Math.sign(b), `block ${j} alternates side`).toBe(-Math.sign(a));
      expect(at(`hull-${j} start`)).toBeGreaterThan(at(`hull-${j - 1} start`));
    }
    const seq: number[] = [at('clamps in')];
    for (let j = 0; j < SHIPYARD_HULL_BLOCKS; j++) seq.push(at(`hull-${j} start`), at(`hull-${j} done`));
    for (const s of SHIPYARD_FIT_STAGES) seq.push(at(`fit-${s} start`), at(`fit-${s} done`));
    for (let i = 5; i >= 0; i--) seq.push(at(`light-${i}`));
    seq.push(at('clamps open'), at('walls open'));
    for (let k = 1; k < seq.length; k++) expect(seq[k], `beat ${k}`).toBeGreaterThan(seq[k - 1]!);
    expect(seq[seq.length - 1]).toBeLessThanOrEqual(SHIPYARD_BUILD_TICKS);
  });

  it('progress 0 is the rest pose and 1 is walls open', () => {
    const pose = createRigPose(rig), playing = { clipId: '', startTick: 0 };
    evaluateRig(rig, shipyardBuildPlaying(0, 800, playing), 800, pose);
    for (let i = 0; i < rig.partCount; i++) expect(pose.value[i], rig.partIds[i]).toBeCloseTo(rig.rest[i]!, 9);
    evaluateRig(rig, shipyardBuildPlaying(1, 800, playing), 800, pose);
    const v = (id: string) => pose.value[rigPartIndex(rig, id)]!;
    for (const w of ['wall-port', 'wall-stbd']) expect(v(w), w).toBeCloseTo(rig.max[rigPartIndex(rig, w)]!, 6);
    for (let i = 0; i < 4; i++) for (const s of ['port', 'stbd']) expect(v(`clamp-${s}-${i}`)).toBeCloseTo(0, 6);
    for (const id of rig.partIds) if (/^(light|hull|fit)-/.test(id)) expect(v(id), id).toBeCloseTo(1, 6);
    expect(v('gantry-hoist')).toBeCloseTo(0, 6);
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
