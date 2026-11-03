/**
 * Patrol faction tint (plan soft-leaping-truffle v4 M2; found 2026-11-03 while
 * surveying rendering for the art-direction plan).
 *
 * Symptom: a garrison patrol ship was meant to wear its faction's colour
 * (`drones[].fac` → `SwarmRenderState.faction`), and the v4 garrison showcase
 * page said it did, but it rendered untinted. `updateSwarmSprites` set the
 * faction tint, then the damage-flash branch further down the SAME pass reset
 * every sprite to white when it wasn't hit. This reads the final drawn tint
 * after a full pass, so it fails on the old code.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import type { Graphics } from 'pixi.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import { DAMAGE_FLASH_COLOR } from './spriteBuilders.js';
import { npcFactionDef, type FactionId } from '../../../shared-types/factions.js';
import type { RenderMirror, SwarmRenderState, PoseRingEntry } from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 });
  return ring;
}

function patrol(faction: FactionId | undefined): SwarmRenderState {
  return {
    x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: 0, prevY: 0, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: emptyPoseRing(), ringHead: 0,
    radius: 13, kind: 1, shipKind: 'patrol-fighter',
    sleeping: true, lastUpdateTick: 0,
    ...(faction !== undefined ? { faction } : {}),
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
    slewDtSec: 1 / 60,
  };
}

const SOL = 'core' as FactionId; // Sol Dominion

describe('updateSwarmSprites — patrol faction tint', () => {
  it('a patrol ship keeps its faction colour after a full pass', () => {
    const color = npcFactionDef(SOL)?.color;
    expect(color, 'sol faction has a colour').toBeDefined();
    const ctx = makeCtx();
    const mirror = { swarm: new Map([[7, patrol(SOL)]]) } as unknown as RenderMirror;
    updateSwarmSprites(mirror, ctx);
    updateSwarmSprites(mirror, ctx);
    expect(ctx.sprites.get('swarm-7')!.tint).toBe(color);
  });

  it('a hit still flashes the damage colour, then the faction colour returns', () => {
    const color = npcFactionDef(SOL)!.color;
    const ctx = makeCtx();
    const mirror = { swarm: new Map([[7, patrol(SOL)]]) } as unknown as RenderMirror;
    ctx.localHitTargets.add('swarm-7');
    updateSwarmSprites(mirror, ctx);
    expect(ctx.sprites.get('swarm-7')!.tint).toBe(DAMAGE_FLASH_COLOR);
    ctx.localHitTargets.clear();
    updateSwarmSprites(mirror, ctx);
    expect(ctx.sprites.get('swarm-7')!.tint).toBe(color);
  });

  it('a ship with no faction stays untinted', () => {
    const ctx = makeCtx();
    const mirror = { swarm: new Map([[7, patrol(undefined)]]) } as unknown as RenderMirror;
    updateSwarmSprites(mirror, ctx);
    expect(ctx.sprites.get('swarm-7')!.tint).toBe(0xffffff);
  });
});
