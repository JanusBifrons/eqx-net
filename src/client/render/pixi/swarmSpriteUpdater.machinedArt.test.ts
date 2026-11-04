/**
 * Machined art in the swarm updater (plan iridescent-seeking-rainbow, A3).
 *
 * A drone draws today's vector look while its art bakes, swaps to the
 * Machined sprite the frame the art is ready, and a patrol uses its faction
 * paint (baked) instead of a tint. A stub art service controls readiness.
 */
import { describe, it, expect } from 'vitest';
import { Container, Graphics, Texture } from 'pixi.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import { DAMAGE_FLASH_COLOR } from './spriteBuilders.js';
import { MachinedShipSprite } from '../art/MachinedShipSprite.js';
import type { ArtHandle, ArtService, ShipArt } from '../art/ArtService.js';
import { npcFactionDef, type FactionId } from '../../../shared-types/factions.js';
import type { RenderMirror, SwarmRenderState, PoseRingEntry } from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 });
  return ring;
}

function drone(shipKind: string, faction?: FactionId): SwarmRenderState {
  return {
    x: 0, y: 0, vx: 0, vy: 0, angle: 0.7, angvel: 0,
    prevX: 0, prevY: 0, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: emptyPoseRing(), ringHead: 0,
    radius: 13, kind: 1, shipKind,
    sleeping: true, lastUpdateTick: 0,
    ...(faction !== undefined ? { faction } : {}),
  } as SwarmRenderState;
}

const shipArt = (): ShipArt => ({
  frames: Array.from({ length: 16 }, () => Texture.EMPTY), w: 40, h: 40, density: 4, nozzles: [], navLights: [],
});

/** A stub art service: every request returns a handle the test flips. */
function stubArt(): { svc: ArtService; handles: ArtHandle[]; makeReady: () => void } {
  const handles: ArtHandle[] = [];
  const svc = {
    ship(id: string, paint?: number): ArtHandle {
      const h: ArtHandle = { key: `${id}:${paint ?? ''}`, job: { type: 'ship', id, paint }, rig: {} as ArtHandle['rig'], state: 'pending', ship: null, struct: null };
      handles.push(h);
      return h;
    },
  } as unknown as ArtService;
  return { svc, handles, makeReady: () => { for (const h of handles) { h.state = 'ready'; h.ship = shipArt(); } } };
}

function makeCtx(art: ArtService | null): SwarmSpriteCtx {
  return {
    shipContainer: new Container(),
    sprites: new Map<string, Container>(),
    mountVisuals: new MountVisualManager(),
    swarmPoseScratch: { x: 0, y: 0, angle: 0 },
    remoteHitTargets: new Set<string>(),
    localHitTargets: new Set<string>(),
    seenScratch: new Set<string>(),
    structureMountAngles: new Map<string, number[]>(),
    spriteKinds: new Map<string, number>(),
    spriteBuildSigs: new Map(),
    art: { art, handles: new Map(), sunAz: -0.6 },
    slewDtSec: 1 / 60,
  };
}

describe('updateSwarmSprites — Machined art', () => {
  it('draws today\'s look while the art bakes, then swaps to Machined', () => {
    const { svc, makeReady } = stubArt();
    const ctx = makeCtx(svc);
    const mirror = { swarm: new Map([[3, drone('fighter')]]) } as unknown as RenderMirror;
    updateSwarmSprites(mirror, ctx);
    expect(ctx.sprites.get('swarm-3')).toBeInstanceOf(Graphics);
    updateSwarmSprites(mirror, ctx);
    expect(ctx.sprites.get('swarm-3')).toBeInstanceOf(Graphics);
    makeReady();
    updateSwarmSprites(mirror, ctx);
    const sp = ctx.sprites.get('swarm-3');
    expect(sp).toBeInstanceOf(MachinedShipSprite);
    expect(ctx.shipContainer.children).toContain(sp);
    expect(ctx.shipContainer.children.filter((c) => c instanceof Graphics)).toHaveLength(0);
  });

  it('acquires each drone\'s art once, not every frame', () => {
    const { svc, handles } = stubArt();
    const ctx = makeCtx(svc);
    const mirror = { swarm: new Map([[3, drone('fighter')]]) } as unknown as RenderMirror;
    for (let i = 0; i < 5; i++) updateSwarmSprites(mirror, ctx);
    expect(handles).toHaveLength(1);
  });

  it('a Machined patrol bakes its faction paint and is not tinted', () => {
    const sol = 'core' as FactionId;
    const { svc, handles, makeReady } = stubArt();
    const ctx = makeCtx(svc);
    const mirror = { swarm: new Map([[5, drone('patrol-fighter', sol)]]) } as unknown as RenderMirror;
    updateSwarmSprites(mirror, ctx);
    expect(handles[0]!.job).toMatchObject({ type: 'ship', id: 'patrol-fighter', paint: npcFactionDef(sol)!.color });
    makeReady();
    updateSwarmSprites(mirror, ctx);
    expect(ctx.sprites.get('swarm-5')).toBeInstanceOf(MachinedShipSprite);
    expect(ctx.sprites.get('swarm-5')!.tint).toBe(0xffffff);
    // A hit still flashes.
    ctx.localHitTargets.add('swarm-5');
    updateSwarmSprites(mirror, ctx);
    expect(ctx.sprites.get('swarm-5')!.tint).toBe(DAMAGE_FLASH_COLOR);
  });

  it('a failed bake keeps today\'s look', () => {
    const { svc, handles } = stubArt();
    const ctx = makeCtx(svc);
    const mirror = { swarm: new Map([[3, drone('heavy')]]) } as unknown as RenderMirror;
    updateSwarmSprites(mirror, ctx);
    handles[0]!.state = 'failed';
    updateSwarmSprites(mirror, ctx);
    expect(ctx.sprites.get('swarm-3')).toBeInstanceOf(Graphics);
  });

  it('with the art off, nothing changes from today', () => {
    const ctx = makeCtx(null);
    const mirror = { swarm: new Map([[3, drone('fighter')]]) } as unknown as RenderMirror;
    updateSwarmSprites(mirror, ctx);
    updateSwarmSprites(mirror, ctx);
    expect(ctx.sprites.get('swarm-3')).toBeInstanceOf(Graphics);
    expect(ctx.art.handles.size).toBe(0);
  });
});
