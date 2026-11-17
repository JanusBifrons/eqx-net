/**
 * Structure restyle 2c: rig parts drawn on structures behind `?rigs=1`.
 * Locks the Pixi Y-flip of a part pose, the layer bands, that the flag-off
 * path builds nothing, and that the per-frame pose path does not grow the
 * display tree (the heap side is structureRigs.heapDelta.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import type { Graphics } from 'pixi.js';
import {
  readRigsFlag, rigLayerZ, rigPartRole, RIG_OVER_Z, partLocalTransform, worldToHost,
  StructureRigView, StructureRigs, RIG_LOOK_C, type PixiXform,
} from './structureRigs.js';
import { BEAMS_OVER_HULL_Z } from './beamsOverHulls.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import type {
  RenderMirror, SwarmRenderState, StructureRenderState, PoseRingEntry,
} from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';
import { rigForStructureKind, DOCK_CRANE_REACH_TICKS, DOOR_TURRET_LIFT } from '../../../core/articulation/rigCatalogue.js';
import { partWorldFrame, type PartFrame } from '../../../core/articulation/mountBridge.js';

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) {
    ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 });
  }
  return ring;
}

function structureEntry(shipKind: string, x: number, y: number, angle: number): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle, angvel: 0,
    prevX: x, prevY: y, prevAngle: angle,
    prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: emptyPoseRing(), ringHead: 0,
    radius: 36, kind: 2, shipKind,
    sleeping: true, lastUpdateTick: 0,
  };
}

function structureState(over: Partial<StructureRenderState> = {}): StructureRenderState {
  return { powered: true, netPower: 10, connTo: [], built: true, buildPct: 1, deconstructPct: 0, ...over };
}

function makeCtx(): SwarmSpriteCtx {
  return {
    shipContainer: new Container(),
    sprites: new Map<string, Graphics>(),
    mountVisuals: new MountVisualManager(),
    swarmPoseScratch: { x: 0, y: 0, angle: 0 },
    remoteHitTargets: new Set<string>(),
    localHitTargets: new Set<string>(),
    seenScratch: new Set<string>(),
    structureMountAngles: new Map<string, number[]>(),
    spriteKinds: new Map<string, number>(),
    spriteBuildSigs: new Map(),
    art: { art: null, handles: new Map(), sunAz: 0 },
    slewDtSec: 100,
  };
}

function mirrorOf(entries: Array<[number, SwarmRenderState]>): RenderMirror {
  const swarm = new Map<number, SwarmRenderState>(entries);
  const structures = new Map<number, StructureRenderState>(entries.map(([id]) => [id, structureState()]));
  return { swarm, structures } as unknown as RenderMirror;
}

/** Every label in a display subtree. */
function labelsUnder(c: Container, out: string[] = []): string[] {
  for (const ch of c.children) {
    if (ch.label) out.push(ch.label);
    labelsUnder(ch as Container, out);
  }
  return out;
}

describe('readRigsFlag', () => {
  it('is on only for rigs=1', () => {
    expect(readRigsFlag('?rigs=1')).toBe(true);
    expect(readRigsFlag('?style=machined&rigs=1&x=2')).toBe(true);
    expect(readRigsFlag('')).toBe(false);
    expect(readRigsFlag('?rigs=0')).toBe(false);
    expect(readRigsFlag('?rigs=10')).toBe(false);
    expect(readRigsFlag('?norigs=1')).toBe(false);
  });
});

describe('layer bands', () => {
  it('over sits above hulls (0) and below the beams band; under/plane ride the body', () => {
    expect(rigLayerZ('under')).toBe(0);
    expect(rigLayerZ('plane')).toBe(0);
    expect(rigLayerZ('over')).toBe(RIG_OVER_Z);
    expect(RIG_OVER_Z).toBeGreaterThan(0);
    expect(RIG_OVER_Z).toBeLessThan(BEAMS_OVER_HULL_Z);
  });

  it('each part lands in its layer group; the over group carries the over band', () => {
    const rig = rigForStructureKind('freight_dock')!;
    const view = new StructureRigView(rig);
    expect(view.over.zIndex).toBe(RIG_OVER_Z);
    for (let i = 0; i < rig.partCount; i++) {
      const part = rig.parts[i]!;
      expect(view.parts[i]!.parent).toBe(view.groupOf(part.layer));
    }
    expect(view.under.children.map((c) => c.label)).toEqual(['rig-part-lip']);
    expect(view.over.children.length).toBeGreaterThan(0);
  });
});

describe('pose → Pixi transform (Y-flip)', () => {
  it('a part composed under a structure sprite lands at the core world frame, y flipped', () => {
    const rig = rigForStructureKind('freight_dock')!;
    const view = new StructureRigView(rig);
    const hx = 300, hy = -140, ha = 0.7;
    view.update({ clipId: 'arm-reach', startTick: 0, targetX: hx + 40, targetY: hy + 20 }, DOCK_CRANE_REACH_TICKS, hx, hy, ha);
    const xf: PixiXform = { x: 0, y: 0, rotation: 0 };
    const wf: PartFrame = { x: 0, y: 0, angle: 0 };
    // The game sprite: (hx, -hy), rotation -ha (swarmSpriteUpdater).
    const sx = hx, sy = -hy, sr = -ha;
    const c = Math.cos(sr), s = Math.sin(sr);
    for (let i = 0; i < rig.partCount; i++) {
      partLocalTransform(view.pose, i, xf);
      const px = sx + xf.x * c - xf.y * s;
      const py = sy + xf.x * s + xf.y * c;
      partWorldFrame(view.pose, i, hx, hy, ha, wf);
      expect(px).toBeCloseTo(wf.x, 6);
      expect(py).toBeCloseTo(-wf.y, 6);
      expect(sr + xf.rotation).toBeCloseTo(-wf.angle, 6);
      // And the Graphics carries exactly that local transform.
      const g = view.parts[i]!;
      expect(g.x).toBeCloseTo(xf.x, 9);
      expect(g.y).toBeCloseTo(xf.y, 9);
      expect(g.rotation).toBeCloseTo(xf.rotation, 9);
    }
  });

  it('worldToHost inverts the host pose and scale', () => {
    const out = { x: 0, y: 0 };
    const hx = 10, hy = 20, ha = 0.5, k = 2;
    const lx = 30, ly = -15;
    const wx = hx + k * (lx * Math.cos(ha) - ly * Math.sin(ha));
    const wy = hy + k * (lx * Math.sin(ha) + ly * Math.cos(ha));
    worldToHost(wx, wy, hx, hy, ha, k, out);
    expect(out.x).toBeCloseTo(lx, 9);
    expect(out.y).toBeCloseTo(ly, 9);
  });

  it('the crane at hold reaches the commanded host-frame target', () => {
    const rig = rigForStructureKind('freight_dock')!;
    const view = new StructureRigView(rig);
    const hx = -50, hy = 80, ha = -0.3;
    const tx = hx + 30, ty = hy - 10;
    view.update({ clipId: 'arm-reach', startTick: 0, targetX: tx, targetY: ty }, DOCK_CRANE_REACH_TICKS + 30, hx, hy, ha);
    // The clamp hangs at the jib tip (the IK end effector).
    const clamp = rig.parts.findIndex((p) => p.id === 'clamp');
    const wf: PartFrame = { x: 0, y: 0, angle: 0 };
    partWorldFrame(view.pose, clamp, hx, hy, ha, wf);
    expect(Math.hypot(wf.x - tx, wf.y - ty)).toBeLessThan(1);
  });
});

describe('updateSwarmSprites with rigs', () => {
  it('flag off (no structureRigs): no rig display objects anywhere', () => {
    const ctx = makeCtx();
    updateSwarmSprites(mirrorOf([[7, structureEntry('freight_dock', 0, 0, 0)], [8, structureEntry('turret', 400, 0, 0)]]), ctx);
    const labels = labelsUnder(ctx.shipContainer);
    expect(labels.some((l) => l.startsWith('rig-'))).toBe(false);
    expect(ctx.shipContainer.sortableChildren).toBe(false);
  });

  it('flag on: a dock gets under/plane on its sprite and over on shipContainer; sweep drops them', () => {
    const ctx = makeCtx();
    const rigs = new StructureRigs(ctx.shipContainer);
    ctx.structureRigs = rigs;
    updateSwarmSprites(mirrorOf([[7, structureEntry('freight_dock', 100, 50, 0.2)], [9, structureEntry('cargo_bay', -400, 0, 0)]]), ctx);
    expect(rigs.size).toBe(1);
    const view = rigs.viewFor('swarm-7')!;
    const sprite = ctx.sprites.get('swarm-7')!;
    expect(view.under.parent).toBe(sprite);
    expect(view.plane.parent).toBe(sprite);
    expect(view.over.parent).toBe(ctx.shipContainer);
    expect(view.over.zIndex).toBe(RIG_OVER_Z);
    expect(view.over.x).toBe(sprite.x);
    expect(view.over.y).toBe(sprite.y);
    expect(view.over.rotation).toBe(sprite.rotation);
    expect(ctx.shipContainer.sortableChildren).toBe(true);
    // The dock leaves: its view goes with it.
    updateSwarmSprites(mirrorOf([[9, structureEntry('cargo_bay', -400, 0, 0)]]), ctx);
    expect(rigs.size).toBe(0);
    expect(labelsUnder(ctx.shipContainer).some((l) => l.startsWith('rig-'))).toBe(false);
  });

  it('turret-deploy pops the mount cluster up in place (scale, no slide); the barrel angle is untouched', () => {
    const ctx = makeCtx();
    const rigs = new StructureRigs(ctx.shipContainer);
    ctx.structureRigs = rigs;
    const mirror = mirrorOf([[5, structureEntry('turret', 0, 0, 0)]]);
    ctx.fxNowMs = 0;
    updateSwarmSprites(mirror, ctx);
    const view = rigs.viewFor('swarm-5')!;
    expect(view.mountPart).toBeGreaterThanOrEqual(0);
    const clusterC = (ctx.mountVisuals as unknown as { clusters: Map<string, { container: Container }> })
      .clusters.get('swarm-5')!.container;
    const restY = clusterC.y, restX = clusterC.x;
    expect(clusterC.scale.x).toBeCloseTo(RIG_LOOK_C.liftScaleRest, 6);
    // Fully sunk under the shut hatch: the gun is not drawn over the leaves.
    expect(clusterC.visible).toBe(false);
    mirror.structures!.get(5)!.rigClip = { clipId: 'turret-deploy', startTick: 0 };
    ctx.fxNowMs = 0;
    updateSwarmSprites(mirror, ctx);
    ctx.fxNowMs = 2000; // 120 ticks: past the 60-tick deploy
    updateSwarmSprites(mirror, ctx);
    // A pop-up rises over its socket: no in-plane travel, it grows.
    expect(clusterC.y).toBeCloseTo(restY, 6);
    expect(clusterC.x).toBeCloseTo(restX, 6);
    expect(clusterC.scale.x).toBeCloseTo(RIG_LOOK_C.liftScaleUp, 6);
    expect(clusterC.visible).toBe(true);
    expect(clusterC.rotation).toBeCloseTo(0, 9);
  });

  it('per-frame pose reuses its arrays and adds no display objects', () => {
    const ctx = makeCtx();
    const rigs = new StructureRigs(ctx.shipContainer);
    ctx.structureRigs = rigs;
    const mirror = mirrorOf([[7, structureEntry('freight_dock', 0, 0, 0)], [5, structureEntry('turret', 600, 0, 0)]]);
    mirror.structures!.get(7)!.rigClip = { clipId: 'arm-reach', startTick: 0, targetX: 10, targetY: -20 };
    mirror.structures!.get(5)!.rigClip = { clipId: 'turret-deploy', startTick: 0 };
    ctx.fxNowMs = 0;
    updateSwarmSprites(mirror, ctx);
    const view = rigs.viewFor('swarm-7')!;
    const xArr = view.pose.x;
    const count = labelsUnder(ctx.shipContainer).length;
    for (let f = 1; f <= 200; f++) {
      ctx.fxNowMs = f * 16.67;
      updateSwarmSprites(mirror, ctx);
    }
    expect(rigs.viewFor('swarm-7')).toBe(view);
    expect(view.pose.x).toBe(xArr);
    expect(labelsUnder(ctx.shipContainer).length).toBe(count);
  });
});

describe('rig clip clock (2e): wire start tick vs the client tick clock', () => {
  /** The pose a fresh view evaluates at `tick` (the reference). */
  function poseAt(kind: string, clip: { clipId: string; startTick: number; targetX?: number; targetY?: number },
    hx: number, hy: number, ha: number, tick: number): number[] {
    const view = new StructureRigView(rigForStructureKind(kind)!);
    const c = Math.cos(ha), s = Math.sin(ha);
    const world = clip.targetX !== undefined && clip.targetY !== undefined
      ? { clipId: clip.clipId, startTick: clip.startTick, targetX: hx + clip.targetX * c - clip.targetY * s, targetY: hy + clip.targetX * s + clip.targetY * c }
      : clip;
    view.update(world, tick, hx, hy, ha, 1);
    return [...view.pose.x, ...view.pose.y, ...view.pose.angle];
  }

  it('a late joiner sees the clip mid-way on its very first frame (no restart)', () => {
    const ctx = makeCtx();
    const rigs = new StructureRigs(ctx.shipContainer);
    ctx.structureRigs = rigs;
    const mirror = mirrorOf([[7, structureEntry('freight_dock', 100, 50, 0.2)]]);
    const clip = { clipId: 'arm-reach', startTick: 5000, targetX: 30, targetY: -40 };
    mirror.structures!.get(7)!.rigClip = clip;
    const mid = 5000 + DOCK_CRANE_REACH_TICKS / 2 + 0.25;
    mirror.rigTick = mid; // joined long after the start
    updateSwarmSprites(mirror, ctx);
    const view = rigs.viewFor('swarm-7')!;
    const got = [...view.pose.x, ...view.pose.y, ...view.pose.angle];
    const want = poseAt('freight_dock', clip, 100, 50, 0.2, mid);
    for (let i = 0; i < want.length; i++) expect(got[i]).toBeCloseTo(want[i]!, 6);
    // ...and it is really mid-clip: neither the rest pose nor the start pose.
    const rest = poseAt('freight_dock', clip, 100, 50, 0.2, 5000);
    expect(got.some((v, i) => Math.abs(v - rest[i]!) > 1e-3)).toBe(true);
  });

  it('a clip that finished before the join shows its end pose', () => {
    const ctx = makeCtx();
    const rigs = new StructureRigs(ctx.shipContainer);
    ctx.structureRigs = rigs;
    const mirror = mirrorOf([[5, structureEntry('turret', 0, 0, 0)]]);
    mirror.structures!.get(5)!.rigClip = { clipId: 'turret-deploy', startTick: 100 };
    mirror.rigTick = 100_000;
    updateSwarmSprites(mirror, ctx);
    const clusterC = (ctx.mountVisuals as unknown as { clusters: Map<string, { container: Container }> })
      .clusters.get('swarm-5')!.container;
    expect(clusterC.scale.x).toBeCloseTo(RIG_LOOK_C.liftScaleUp, 6);
    // Same structure seen with no clip: the rest pose (sunk).
    mirror.structures!.get(5)!.rigClip = undefined;
    updateSwarmSprites(mirror, ctx);
    expect(clusterC.scale.x).toBeCloseTo(RIG_LOOK_C.liftScaleRest, 6);
  });
});

describe('rig part look (2c+)', () => {
  it('pop-up riser rises in place: grows, its shadow widens and drifts; lift progress drives it', () => {
    const rig = rigForStructureKind('turret')!;
    const v = new StructureRigView(rig);
    const r = v.riserPart;
    expect(r).toBe(v.mountPart);
    v.update(null, 0, 0, 0, 0);
    const x0 = v.parts[r]!.x, y0 = v.parts[r]!.y, s0 = v.shadows[r]!.x - x0, a0 = v.shadows[r]!.alpha;
    expect(v.parts[r]!.scale.x).toBeCloseTo(RIG_LOOK_C.liftScaleRest, 6);
    v.update({ clipId: 'turret-deploy', startTick: 0 }, 1000, 0, 0, 0);
    expect(v.pose.value[r]).toBeCloseTo(DOOR_TURRET_LIFT, 6);
    expect(v.parts[r]!.x).toBeCloseTo(x0, 6);
    expect(v.parts[r]!.y).toBeCloseTo(y0, 6);
    expect(v.parts[r]!.scale.x).toBeCloseTo(RIG_LOOK_C.liftScaleUp, 6);
    expect(v.shadows[r]!.x - x0).toBeCloseTo(s0 + RIG_LOOK_C.liftShadow, 6);
    expect(v.shadows[r]!.alpha).toBeGreaterThan(a0);
    // Half-way through the rise (ticks 15..60, linear-ish in): scale between.
    v.update({ clipId: 'turret-deploy', startTick: 0 }, 37.5, 0, 0, 0);
    expect(v.parts[r]!.scale.x).toBeGreaterThan(RIG_LOOK_C.liftScaleRest);
    expect(v.parts[r]!.scale.x).toBeLessThan(RIG_LOOK_C.liftScaleUp);
  });

  it('the hatch leaves draw over the riser: shut they cover its drawn top at full size, open they clear it', () => {
    const rig = rigForStructureKind('turret')!;
    const v = new StructureRigView(rig);
    const r = v.riserPart;
    const L = rig.partIds.indexOf('door-left'), R = rig.partIds.indexOf('door-right');
    // Drawn above the riser (later in the plane group).
    expect(v.plane.getChildIndex(v.parts[L]!)).toBeGreaterThan(v.plane.getChildIndex(v.parts[r]!));
    expect(v.plane.getChildIndex(v.parts[R]!)).toBeGreaterThan(v.plane.getChildIndex(v.parts[r]!));
    // Riser half extents at full lift (pixi frame, centred on the socket).
    const ro = rig.parts[r]!.outline!;
    let hw = 0, hh = 0;
    for (let j = 0; j < ro.length; j += 2) { hw = Math.max(hw, Math.abs(ro[j]!)); hh = Math.max(hh, Math.abs(ro[j + 1]!)); }
    hw *= RIG_LOOK_C.liftScaleUp; hh *= RIG_LOOK_C.liftScaleUp;
    const leafBox = (i: number): { x0: number; x1: number; y0: number; y1: number } => {
      const b = v.parts[i]!.getLocalBounds();
      const g = v.parts[i]!;
      return { x0: g.x + b.minX, x1: g.x + b.maxX, y0: g.y + b.minY, y1: g.y + b.maxY };
    };
    v.update(null, 0, 0, 0, 0);
    const l0 = leafBox(L), r0 = leafBox(R);
    expect(v.parts[r]!.x).toBeCloseTo(0, 9);
    expect(v.parts[r]!.y).toBeCloseTo(0, 9);
    expect(l0.x0).toBeLessThanOrEqual(-hw);
    expect(r0.x1).toBeGreaterThanOrEqual(hw);
    expect(Math.min(l0.y0, r0.y0)).toBeLessThanOrEqual(-hh);
    expect(Math.max(l0.y1, r0.y1)).toBeGreaterThanOrEqual(hh);
    v.update({ clipId: 'turret-deploy', startTick: 0 }, 1000, 0, 0, 0);
    // The leaf art strokes its edge, so its bounds run ~1.3 u past the outline.
    expect(leafBox(L).x1).toBeLessThan(-hw);
    expect(leafBox(R).x0).toBeGreaterThan(hw);
  });

  it('door leaves sit over a dark hatch slot (under every plane part); no slot on a rig without leaves', () => {
    const v = new StructureRigView(rigForStructureKind('turret')!);
    expect(v.slot).not.toBeNull();
    expect(v.plane.getChildIndex(v.slot!)).toBe(0);
    const b = v.slot!.getLocalBounds();
    // Spans both shut leaves (2 x 24 wide) over the socket.
    expect(b.width).toBeGreaterThanOrEqual(48);
    expect(b.height).toBeGreaterThanOrEqual(48);
    expect(new StructureRigView(rigForStructureKind('freight_dock')!).slot).toBeNull();
  });


  it('reads each part role from the rig shape', () => {
    const crane = rigForStructureKind('freight_dock')!;
    const roles = crane.parts.map((_, i) => `${crane.parts[i]!.id}:${rigPartRole(crane, i)}`);
    expect(roles).toEqual(expect.arrayContaining(['lip:pad', 'plinth:base', 'boom:beam', 'jib:beam', 'clamp:head']));
    const turret = rigForStructureKind('turret')!;
    const t = turret.parts.map((_, i) => `${turret.parts[i]!.id}:${rigPartRole(turret, i)}`);
    expect(t).toEqual(expect.arrayContaining(['door-left:leaf', 'door-right:leaf', 'turret-lift:riser']));
  });

  it('shares one art context per part and gives lifted parts a shadow on it', () => {
    const rig = rigForStructureKind('freight_dock')!;
    const a = new StructureRigView(rig), b = new StructureRigView(rig);
    for (let i = 0; i < rig.partCount; i++) {
      expect(a.parts[i]!.context).toBe(b.parts[i]!.context);
      const sh = a.shadows[i];
      if (rig.parts[i]!.layer === 'under') expect(sh).toBeNull();
      else {
        expect(sh!.context).toBe(a.parts[i]!.context);
        expect(sh!.parent).toBe(a.parts[i]!.parent);
        expect(sh!.parent!.getChildIndex(sh!)).toBeLessThan(a.parts[i]!.parent!.getChildIndex(a.parts[i]!));
      }
    }
    a.update(null, 0, 0, 0, 0);
    const boom = rig.parts.findIndex((p) => p.id === 'boom');
    expect(a.shadows[boom]!.x).toBeGreaterThan(a.parts[boom]!.x);
    expect(a.shadows[boom]!.rotation).toBe(a.parts[boom]!.rotation);
  });
});
