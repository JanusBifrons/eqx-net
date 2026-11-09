/**
 * A6 hot wreckage: freshly broken scrap glows hot orange and cools to its own
 * colour over SCRAP_COOL_MS (timed from when the client first draws it). Loot
 * pods ride the same scrap channel and must never glow.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Container } from 'pixi.js';
import type { Graphics } from 'pixi.js';
import { updateSwarmSprites, scrapHeatTint, SCRAP_COOL_MS, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import type { RenderMirror, SwarmRenderState, PoseRingEntry } from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 });
  return ring;
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
    art: { art: null, handles: new Map(), sunAz: 0 }, // Machined art off: today's look
    slewDtSec: 1 / 60,
  };
}


function scrap(parent: string): SwarmRenderState {
  return {
    x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: 0, prevY: 0, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: emptyPoseRing(), ringHead: 0,
    radius: 10, kind: 3, shipKind: parent, componentIndex: 0,
    sleeping: true, lastUpdateTick: 0,
  } as SwarmRenderState;
}

afterEach(() => vi.restoreAllMocks());

describe('scrapHeatTint', () => {
  it('starts hot orange and cools to none', () => {
    expect(scrapHeatTint(0)).toBe(0xff7a30);
    const mid = scrapHeatTint(SCRAP_COOL_MS / 2)!;
    expect(mid).toBeGreaterThan(0xff7a30);
    expect(mid).toBeLessThan(0xffffff);
    expect(scrapHeatTint(SCRAP_COOL_MS)).toBeUndefined();
    expect(scrapHeatTint(-Infinity)).toBeUndefined();
  });
});

describe('updateSwarmSprites — hot wreckage', () => {
  it('a fresh scrap piece is drawn hot, then cool once it has aged', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const ctx = makeCtx();
    const mirror = { swarm: new Map([[9, scrap('fighter')]]) } as unknown as RenderMirror;
    updateSwarmSprites(mirror, ctx);
    expect(ctx.sprites.get('swarm-9')!.tint).toBe(0xff7a30);
    now += SCRAP_COOL_MS + 1;
    updateSwarmSprites(mirror, ctx);
    expect(ctx.sprites.get('swarm-9')!.tint).toBe(0xffffff);
  });

  it('a loot pod is never heat-tinted', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const ctx = makeCtx();
    const mirror = { swarm: new Map([[9, scrap('cargo-pod')]]) } as unknown as RenderMirror;
    updateSwarmSprites(mirror, ctx);
    expect(ctx.sprites.get('swarm-9')!.tint).toBe(0xffffff);
  });
});
