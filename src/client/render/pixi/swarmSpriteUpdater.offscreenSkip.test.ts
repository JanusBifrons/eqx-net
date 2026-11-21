/**
 * Perf lock (#13, count-based): an off-screen structure is hidden
 * (`isSpriteInView`), and its guns are children of that hidden sprite, so
 * re-posing them every frame is wasted work. Sol Prime's big base on a phone
 * spent ~257 ms / 8 s in `applyMountAngles` (+125 ms `animateGun`) for
 * structures mostly off screen.
 *
 * Locks: N unchanged off-screen turrets over K frames make ZERO
 * `applyMountAngles` calls (on-screen ones still make N × K), and the barrel
 * slew keeps running while hidden, so a turret that scrolls back into view
 * shows exactly the angle it would have had (the look does not change).
 */
import { describe, it, expect, vi } from 'vitest';
import { Container } from 'pixi.js';
import type { Graphics } from 'pixi.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import type { RenderMirror, SwarmRenderState, StructureRenderState, PoseRingEntry } from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 });
  return ring;
}

function entry(kind: number, shipKind: string, x: number, y: number): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0, prevX: x, prevY: y, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: 0, poseRing: emptyPoseRing(), ringHead: 0,
    radius: kind === 2 ? 36 : 12, kind, shipKind, sleeping: true, lastUpdateTick: 0,
  };
}

function structureState(over: Partial<StructureRenderState>): StructureRenderState {
  return { powered: true, netPower: 10, connTo: [], built: true, buildPct: 1, deconstructPct: 0, ...over };
}

function makeCtx(): SwarmSpriteCtx {
  return {
    shipContainer: new Container(), sprites: new Map<string, Graphics>(), mountVisuals: new MountVisualManager(),
    swarmPoseScratch: { x: 0, y: 0, angle: 0 }, remoteHitTargets: new Set<string>(), localHitTargets: new Set<string>(),
    seenScratch: new Set<string>(), structureMountAngles: new Map<string, number[]>(), spriteKinds: new Map<string, number>(),
    spriteBuildSigs: new Map(), art: { art: null, handles: new Map(), sunAz: 0 }, slewDtSec: 1 / 60,
  };
}

/** Pixi-space view rect [minX, minY, maxX, maxY]. */
const ON_SCREEN = new Float64Array([-10_000, -10_000, 10_000, 10_000]);
const OFF_SCREEN = new Float64Array([50_000, 50_000, 51_000, 51_000]);

function turretMirror(n: number): RenderMirror {
  const swarm = new Map<number, SwarmRenderState>();
  const structures = new Map<number, StructureRenderState>();
  for (let i = 0; i < n; i++) {
    swarm.set(100 + i, entry(2, 'turret', i * 100, 0));
    structures.set(100 + i, structureState({}));
  }
  return { swarm, structures } as unknown as RenderMirror;
}

describe('updateSwarmSprites — off-screen structures skip mount posing', () => {
  const N = 20, K = 10;

  it(`${N} off-screen turrets over ${K} frames: no applyMountAngles call`, () => {
    const ctx = makeCtx();
    const spy = vi.spyOn(ctx.mountVisuals, 'applyMountAngles');
    const mirror = turretMirror(N);
    ctx.viewBounds = OFF_SCREEN;
    for (let k = 0; k < K; k++) updateSwarmSprites(mirror, ctx);
    for (const s of ctx.sprites.values()) expect(s.visible).toBe(false);
    expect(spy.mock.calls.length).toBe(0); // was N × K = 200
  });

  it(`${N} on-screen turrets over ${K} frames: every frame still poses every gun`, () => {
    const ctx = makeCtx();
    const spy = vi.spyOn(ctx.mountVisuals, 'applyMountAngles');
    const mirror = turretMirror(N);
    ctx.viewBounds = ON_SCREEN;
    for (let k = 0; k < K; k++) updateSwarmSprites(mirror, ctx);
    expect(spy.mock.calls.length).toBe(N * K);
  });

  it('a turret that scrolls back into view shows the angle it would have had on screen', () => {
    const run = (hiddenFrames: number): number => {
      const ctx = makeCtx();
      const swarm = new Map<number, SwarmRenderState>([[100, entry(2, 'turret', 0, 0)], [200, entry(1, 'fighter', 400, 0)]]);
      // Defence turret: eases toward the server's angle (90° right).
      const structures = new Map<number, StructureRenderState>([[100, structureState({ turretTargetId: 200, mountAngles: [Math.atan2(-400, 0)] })]]);
      const mirror = { swarm, structures, ships: new Map() } as unknown as RenderMirror;
      for (let k = 0; k < 30; k++) {
        ctx.viewBounds = k < hiddenFrames ? OFF_SCREEN : ON_SCREEN;
        updateSwarmSprites(mirror, ctx);
      }
      const mount = getStructureKind('turret').mounts![0]!;
      return (ctx.mountVisuals as unknown as { clusters: Map<string, { perMount: Map<string, { turret: Graphics }> }> })
        .clusters.get('swarm-100')!.perMount.get(mount.id)!.turret.rotation;
    };
    const always = run(0);
    expect(Math.abs(always)).toBeGreaterThan(0.1); // it really slewed
    expect(run(20)).toBe(always);
  });
});
