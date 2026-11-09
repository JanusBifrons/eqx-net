/**
 * Classic-look asteroid resource tint (wrap-up W3; the "classic asteroid tint
 * bug" from the art-direction plan). Ice and crystal-veined rocks are tinted
 * once when the sprite is built, then the damage-flash branch further down the
 * same pass reset every sprite's tint to white each frame, so in the classic
 * look every rock rendered plain grey. Reads the drawn tint after full passes,
 * so it fails on the old code (the same shape as the patrol faction-tint bug).
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import type { Graphics } from 'pixi.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import { DAMAGE_FLASH_COLOR } from './spriteBuilders.js';
import type { RenderMirror, SwarmRenderState, PoseRingEntry } from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 });
  return ring;
}

function rock(asteroidResource?: 'ice' | 'crystal'): SwarmRenderState {
  return {
    x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: 0, prevY: 0, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: emptyPoseRing(), ringHead: 0,
    radius: 40, kind: 0, sleeping: true, lastUpdateTick: 0,
    ...(asteroidResource ? { asteroidResource } : {}),
  } as SwarmRenderState;
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
    art: { art: null, handles: new Map(), sunAz: 0 }, // the classic look
    slewDtSec: 1 / 60,
  };
}

describe('updateSwarmSprites — classic asteroid resource tint', () => {
  it('ice and crystal rocks keep their tint after full passes; plain rock stays white', () => {
    const ctx = makeCtx();
    const mirror = { swarm: new Map([[1, rock('ice')], [2, rock('crystal')], [3, rock()]]) } as unknown as RenderMirror;
    updateSwarmSprites(mirror, ctx);
    updateSwarmSprites(mirror, ctx);
    expect(ctx.sprites.get('swarm-1')!.tint).toBe(0xa8dcff);
    expect(ctx.sprites.get('swarm-2')!.tint).toBe(0xd2a8ff);
    expect(ctx.sprites.get('swarm-3')!.tint).toBe(0xffffff);
  });

  it('a hit still flashes the damage colour, then the ice tint returns', () => {
    const ctx = makeCtx();
    const mirror = { swarm: new Map([[1, rock('ice')]]) } as unknown as RenderMirror;
    ctx.localHitTargets.add('swarm-1');
    updateSwarmSprites(mirror, ctx);
    expect(ctx.sprites.get('swarm-1')!.tint).toBe(DAMAGE_FLASH_COLOR);
    ctx.localHitTargets.clear();
    updateSwarmSprites(mirror, ctx);
    expect(ctx.sprites.get('swarm-1')!.tint).toBe(0xa8dcff);
  });
});
