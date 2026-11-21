/**
 * Build mirror drawing (base loop 4C): a structure placed mirrored draws
 * left-right flipped in its local frame (the sprite's x scale is negative,
 * `structureLocalToWorld`: flip local x, then rotate), while its readouts
 * stay readable (the build-ETA text is not mirrored) and its gun cluster
 * keeps its world aim (counter-flipped, #12).
 */
import { describe, it, expect } from 'vitest';
import { Container, Point } from 'pixi.js';
import type { Graphics } from 'pixi.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import type { RenderMirror, SwarmRenderState, StructureRenderState, PoseRingEntry } from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import { structureLocalToWorld } from '../../../shared-types/structureKinds/geometry.js';
import { applyStructureMirror, counterFlipStructureParts } from './structureMirrorFlip.js';

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 });
  return ring;
}

function entry(shipKind: string): SwarmRenderState {
  return {
    x: 0, y: 0, vx: 0, vy: 0, angle: Math.PI / 2, angvel: 0, prevX: 0, prevY: 0, prevAngle: Math.PI / 2,
    prevArrivalMs: 0, latestArrivalMs: 0, poseRing: emptyPoseRing(), ringHead: 0,
    radius: 60, kind: 2, shipKind, sleeping: true, lastUpdateTick: 0,
  };
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
    slewDtSec: 0.016,
    cameraScale: 0.5,
  };
}

function drawOnce(shipKind: string, mirror: boolean | undefined, built = false) {
  const ctx = makeCtx();
  const swarm = new Map<number, SwarmRenderState>([[7, entry(shipKind)]]);
  const structures = new Map<number, StructureRenderState>([[7, {
    powered: false, netPower: 0, connTo: [], built, buildPct: 0.1, deconstructPct: 0, etaMs: 7000, mirror,
  }]]);
  const m = { swarm, structures } as unknown as RenderMirror;
  updateSwarmSprites(m, ctx);
  const sprite = [...ctx.sprites.values()][0]!;
  return { ctx, sprite, m };
}

describe('updateSwarmSprites — build mirror draws the structure flipped (4C)', () => {
  it('a mirrored structure has a negative x scale; an unmirrored one positive', () => {
    expect(drawOnce('solar', true).sprite.scale.x).toBeLessThan(0);
    expect(drawOnce('solar', false).sprite.scale.x).toBeGreaterThan(0);
    expect(drawOnce('solar', undefined).sprite.scale.x).toBeGreaterThan(0);
  });

  it('keeps the rotation (flip in the local frame, then rotate)', () => {
    const { sprite } = drawOnce('solar', true);
    expect(sprite.rotation).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('the build-ETA text stays readable (not mirrored on screen)', () => {
    const { sprite } = drawOnce('solar', true);
    const t = sprite.getChildByLabel('buildEta')!;
    expect(t.scale.x * sprite.scale.x).toBeGreaterThan(0);
  });

  it('a turret\'s gun cluster is counter-flipped, so its aim stays true in the world', () => {
    const { sprite, ctx } = drawOnce('turret', true, true);
    const sk = getStructureKind('turret');
    expect((sk.mounts ?? []).length).toBeGreaterThan(0);
    // Idempotent: returns the cluster the updater built.
    const cluster = ctx.mountVisuals.ensureForMounts('swarm-7', sk.id, sk.mounts!, sk.color, sprite);
    expect(cluster.scale.x * sprite.scale.x).toBeGreaterThan(0);
  });

  it('un-mirroring a recycled sprite flips it back', () => {
    const { sprite, ctx, m } = drawOnce('solar', true);
    m.structures!.get(7)!.mirror = false;
    updateSwarmSprites(m, ctx);
    expect(sprite.scale.x).toBeGreaterThan(0);
  });
});

describe('build mirror: guns sit where the server puts the mount (4C)', () => {
  // A structure at a game pose with one gun at a non-centre local point
  // (the server's mount place is structureLocalToWorld(mount, mirror)).
  const hx = 120, hy = -60, ha = 0.9, lx = 30, ly = 14, base = 0.25, arc = 0.4;
  function drawGun(mirror: boolean): { at: { x: number; y: number }; aim: number } {
    const root = new Container();
    const sprite = new Container();
    root.addChild(sprite);
    sprite.position.set(hx, -hy);
    sprite.rotation = -ha;
    const cluster = new Container();
    sprite.addChild(cluster);
    const gun = new Container();
    cluster.addChild(gun);
    gun.position.set(lx, -ly); // as MountVisualManager lays a mount out
    gun.rotation = -(base + arc); // applyMountAngles: arc-local aim
    applyStructureMirror(sprite, mirror);
    counterFlipStructureParts(sprite, cluster);
    counterFlipStructureParts(sprite, cluster); // idempotent per frame
    const o = gun.toGlobal(new Point(0, 0));
    const f = gun.toGlobal(new Point(0, -1)); // the barrel's forward (Pixi up = game +y)
    return { at: { x: o.x, y: -o.y }, aim: Math.atan2(-(f.x - o.x), -(f.y - o.y)) };
  }

  it('the drawn gun position is the server mount position, mirrored or not', () => {
    for (const mirror of [false, true]) {
      const w = structureLocalToWorld(lx, ly, hx, hy, Math.cos(ha), Math.sin(ha), mirror, { x: 0, y: 0 });
      const { at } = drawGun(mirror);
      expect(at.x).toBeCloseTo(w.x, 6);
      expect(at.y).toBeCloseTo(w.y, 6);
    }
  });

  it('the barrel keeps the true aim angle (the same world bearing mirrored or not)', () => {
    const plain = drawGun(false).aim;
    const flipped = drawGun(true).aim;
    expect(Math.atan2(Math.sin(flipped - plain), Math.cos(flipped - plain))).toBeCloseTo(0, 6);
    expect(plain).toBeCloseTo(ha + base + arc, 6); // world bearing = body + base + arc
  });
});
