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
  readRigsFlag, rigLayerZ, rigPartRole, RIG_OVER_Z, RIG_UNDER_Z, partLocalTransform, worldToHost,
  StructureRigView, StructureRigs, RIG_LOOK_C, type PixiXform,
} from './structureRigs.js';
import { BEAMS_OVER_HULL_Z } from './beamsOverHulls.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import type {
  RenderMirror, SwarmRenderState, StructureRenderState, PoseRingEntry,
} from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';
import { rigClipIndex } from '../../../core/articulation/rig.js';
import { rigForStructureKind, DOCK_CRANE_REACH_TICKS, DOOR_TURRET_LIFT } from '../../../core/articulation/rigCatalogue.js';
import { partWorldFrame, type PartFrame } from '../../../core/articulation/mountBridge.js';
import { CRANE_CARGO_BOTH, CRANE_CARGO_IN, CRANE_CARGO_OUT, craneArmPath } from '../../../core/articulation/craneCargo.js';

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
  it('over sits above hulls (0) and below the beams band; the pad deck below hulls; plane rides the body', () => {
    expect(rigLayerZ('under')).toBe(RIG_UNDER_Z);
    expect(RIG_UNDER_Z).toBeLessThan(0);
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

  it('flag on: a dock gets plane on its sprite, under and over on shipContainer; sweep drops them', () => {
    const ctx = makeCtx();
    const rigs = new StructureRigs(ctx.shipContainer);
    ctx.structureRigs = rigs;
    updateSwarmSprites(mirrorOf([[7, structureEntry('freight_dock', 100, 50, 0.2)], [9, structureEntry('cargo_bay', -400, 0, 0)]]), ctx);
    expect(rigs.size).toBe(1);
    const view = rigs.viewFor('swarm-7')!;
    const sprite = ctx.sprites.get('swarm-7')!;
    expect(view.plane.parent).toBe(sprite);
    for (const [g, z] of [[view.under, RIG_UNDER_Z], [view.over, RIG_OVER_Z]] as const) {
      expect(g.parent).toBe(ctx.shipContainer);
      expect(g.zIndex).toBe(z);
      expect(g.x).toBe(sprite.x);
      expect(g.y).toBe(sprite.y);
      expect(g.rotation).toBe(sprite.rotation);
    }
    expect(ctx.shipContainer.sortableChildren).toBe(true);
    // The dock leaves: its view goes with it.
    updateSwarmSprites(mirrorOf([[9, structureEntry('cargo_bay', -400, 0, 0)]]), ctx);
    expect(rigs.size).toBe(0);
    expect(labelsUnder(ctx.shipContainer).some((l) => l.startsWith('rig-'))).toBe(false);
  });

  it('a ship on the pad draws over the pad deck, whichever sprite was added first', () => {
    // Film unload-1: the player's hull (added at join) vanished under the
    // dock's landing apron once it parked on the pad. Pixi draws
    // `shipContainer` children by zIndex, then insertion order.
    const ctx = makeCtx();
    ctx.shipContainer.sortableChildren = true; // as raiseBeamsOverHulls leaves it
    const hull = new Container();
    hull.label = 'hull';
    ctx.shipContainer.addChild(hull); // the player's ship, before the dock
    const rigs = new StructureRigs(ctx.shipContainer);
    ctx.structureRigs = rigs;
    updateSwarmSprites(mirrorOf([[7, structureEntry('freight_dock', 0, 0, 0)]]), ctx);
    const view = rigs.viewFor('swarm-7')!;
    /** Draw rank of `c` in shipContainer (its top-level ancestor's slot). */
    const rank = (c: Container): [number, number] => {
      let top = c;
      while (top.parent !== ctx.shipContainer) top = top.parent as Container;
      return [top.zIndex, ctx.shipContainer.getChildIndex(top)];
    };
    const [hz, hi] = rank(hull);
    const [uz, ui] = rank(view.under);
    expect(uz < hz || (uz === hz && ui < hi), 'the apron draws below the hull').toBe(true);
  });

  it('turret-deploy pops the mount cluster up in place (scale, no slide); the barrel angle is untouched', () => {
    const ctx = makeCtx();
    const rigs = new StructureRigs(ctx.shipContainer);
    ctx.structureRigs = rigs;
    const mirror = mirrorOf([[5, structureEntry('turret', 0, 0, 0)]]);
    // Stowed: the hatch shut over the sunk turret (no clip would idle deployed).
    mirror.structures!.get(5)!.rigClip = { clipId: 'door-close', startTick: -1000 };
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
    // Packed away: the sunk pose, the gun hidden under the hatch.
    mirror.structures!.get(5)!.rigClip = { clipId: 'turret-retract', startTick: 100 };
    updateSwarmSprites(mirror, ctx);
    expect(clusterC.scale.x).toBeCloseTo(RIG_LOOK_C.liftScaleRest, 6);
    expect(clusterC.visible).toBe(false);
    // Same structure seen with no clip: the idle pose (deployed, gun up),
    // as the server fires it (`rigDeployed`).
    mirror.structures!.get(5)!.rigClip = undefined;
    updateSwarmSprites(mirror, ctx);
    expect(clusterC.scale.x).toBeCloseTo(RIG_LOOK_C.liftScaleUp, 6);
    expect(clusterC.visible).toBe(true);
  });
});

describe('rig part look (2c+)', () => {
  it('a fully sunk riser casts no shadow and draws nothing; the shadow fades in with the rise (2h)', () => {
    const rig = rigForStructureKind('turret')!;
    const v = new StructureRigView(rig);
    const r = v.riserPart;
    const sh = v.shadows[r]!;
    // Packed under the shut hatch: no shadow peeks past the leaves.
    v.update({ clipId: 'turret-retract', startTick: 0 }, 1000, 0, 0, 0);
    expect(v.lift).toBe(0);
    expect(sh.visible).toBe(false);
    expect(sh.alpha).toBe(0);
    expect(v.parts[r]!.visible).toBe(false);
    // Rising: the shadow fades in, never popping to a fixed alpha.
    let prev = 0;
    for (let tick = 16; tick <= 60; tick += 4) {
      v.update({ clipId: 'turret-deploy', startTick: 0 }, tick, 0, 0, 0);
      expect(sh.visible).toBe(true);
      expect(v.parts[r]!.visible).toBe(true);
      expect(sh.alpha).toBeCloseTo(RIG_LOOK_C.liftShadowAlphaUp * v.lift, 9);
      expect(sh.alpha).toBeGreaterThan(prev);
      prev = sh.alpha;
    }
    // Just off the floor the shadow is faint.
    v.update({ clipId: 'turret-deploy', startTick: 0 }, 16, 0, 0, 0);
    expect(sh.alpha).toBeLessThan(0.05);
    // Fully risen: full shadow.
    v.update({ clipId: 'turret-deploy', startTick: 0 }, 1000, 0, 0, 0);
    expect(sh.alpha).toBeCloseTo(RIG_LOOK_C.liftShadowAlphaUp, 9);
    // No clip: the idle pose is deployed (as the server fires it).
    v.update(null, 0, 0, 0, 0);
    expect(v.lift).toBe(1);
    expect(sh.visible).toBe(true);
  });

  it('pop-up riser rises in place: grows, its shadow widens and drifts; lift progress drives it', () => {
    const rig = rigForStructureKind('turret')!;
    const v = new StructureRigView(rig);
    const r = v.riserPart;
    expect(r).toBe(v.mountPart);
    v.update({ clipId: 'door-close', startTick: 0 }, 1000, 0, 0, 0);
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

describe('goods flow pulse along the crane arm (3e)', () => {
  const rig = rigForStructureKind('freight_dock')!;
  const hx = 200, hy = -100, ha = 0.4;
  const hold = { clipId: 'arm-hold', startTick: 1000, targetX: hx + 60, targetY: hy + 450, holdTicks: 300, cargo: CRANE_CARGO_IN };
  // 51 ticks = one CONNECTOR_PULSE_PERIOD_MS (850 ms) at 60 Hz: tick 1020 + k
  // puts the pulse k/51 of the way along the arm.
  /** How far along the arm (arc length from the clamp) the pulse's centre
   *  sits: its nearest point on the posed arm (Pixi frame, y flipped). */
  function fromClamp(view: StructureRigView): number {
    const b = view.cargo!.getLocalBounds();
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const path = new Float64Array(2 * (rig.maxChain + 1));
    const n = craneArmPath(rig, rigClipIndex(rig, 'arm-hold'), view.pose, path);
    let best = Infinity, at = 0, cum = 0;
    for (let k = 0; k + 1 < n; k++) {
      const ax = path[2 * k]!, ay = -path[2 * k + 1]!, bx = path[2 * k + 2]!, by = -path[2 * k + 3]!;
      const len = Math.hypot(bx - ax, by - ay);
      const f = Math.max(0, Math.min(1, ((cx - ax) * (bx - ax) + (cy - ay) * (by - ay)) / (len * len)));
      const d = Math.hypot(ax + (bx - ax) * f - cx, ay + (by - ay) * f - cy);
      if (d < best) { best = d; at = cum + f * len; }
      cum += len;
    }
    expect(best).toBeLessThan(1); // on the arm
    return at;
  }

  it('an unload runs the cable pulse from the clamp into the dock, over the arm parts', () => {
    const view = new StructureRigView(rig);
    const g = view.cargo!;
    expect(g.parent).toBe(view.over);
    expect(view.over.getChildIndex(g)).toBe(view.over.children.length - 1);
    view.update(hold, 1020 + 5, hx, hy, ha);
    expect(g.visible).toBe(true);
    const near = fromClamp(view);
    view.update(hold, 1020 + 40, hx, hy, ha);
    const far = fromClamp(view);
    expect(near).toBeLessThan(100);
    expect(far).toBeGreaterThan(near + 300);
    // Gone once the hold is over.
    view.update(hold, 1000 + 300, hx, hy, ha);
    expect(g.visible).toBe(false);
    view.update({ ...hold, clipId: 'arm-retract', holdTicks: undefined, cargo: undefined }, 1400, hx, hy, ha);
    expect(g.visible).toBe(false);
  });

  it('a load runs it from the dock out to the clamp; a mixed dock does both halves', () => {
    const view = new StructureRigView(rig);
    const load = { ...hold, cargo: CRANE_CARGO_OUT };
    view.update(load, 1020 + 5, hx, hy, ha);
    const early = fromClamp(view);
    view.update(load, 1020 + 40, hx, hy, ha);
    expect(fromClamp(view)).toBeLessThan(early - 300);
    const mixed = { ...hold, cargo: CRANE_CARGO_BOTH };
    view.update(mixed, 1020 + 5, hx, hy, ha); // first half: in
    const inA = fromClamp(view);
    view.update(mixed, 1020 + 40, hx, hy, ha);
    expect(fromClamp(view)).toBeGreaterThan(inA + 300);
    view.update(mixed, 1173 + 5, hx, hy, ha); // second half: out
    const outA = fromClamp(view);
    view.update(mixed, 1173 + 40, hx, hy, ha);
    expect(fromClamp(view)).toBeLessThan(outA - 300);
  });

  it('no hold on the wire (a staged / older clip): no pulse', () => {
    const view = new StructureRigView(rig);
    view.update({ clipId: 'arm-hold', startTick: 0, targetX: hx, targetY: hy + 450 }, 50, hx, hy, ha);
    expect(view.cargo!.visible).toBe(false);
  });

  it('a rig without an IK chain gets no pulse', () => {
    expect(new StructureRigView(rigForStructureKind('turret')!).cargo).toBeNull();
  });
});
