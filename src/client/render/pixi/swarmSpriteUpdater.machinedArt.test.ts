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
import type { ArtHandle, ArtService, ShipArt, StructArt } from '../art/ArtService.js';
import { MachinedFlatSprite } from '../art/MachinedFlatSprite.js';
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

/** One sun for the stub service (handles match it, so nothing re-acquires). */
const RIG = {} as ArtHandle['rig'];

/** A stub art service: every request returns a handle the test flips. */
function stubArt(): { svc: ArtService; handles: ArtHandle[]; makeReady: () => void } {
  const handles: ArtHandle[] = [];
  const mk = (job: ArtHandle['job']): ArtHandle => {
    const h: ArtHandle = { key: JSON.stringify(job), job, rig: RIG, state: 'pending', ship: null, struct: null };
    handles.push(h);
    return h;
  };
  const svc = {
    lightRig: RIG,
    ship: (id: string, paint?: number) => mk({ type: 'ship', id, paint }),
    struct: (id: string, seed: number, rot = 0) => mk({ type: 'struct', id, seed, rot }),
    scrap: (id: string, component: number) => mk({ type: 'scrap', id, component }),
    rock: (entityId: number, radius: number, resource: string | undefined, rot: number) =>
      mk({ type: 'rock', id: 'asteroid', entityId, radius, resource, rot }),
  } as unknown as ArtService;
  const flat = (): StructArt => ({ tex: Texture.EMPTY, albedo: Texture.EMPTY, w: 40, h: 40, density: 2, navLights: [] });
  return {
    svc, handles,
    makeReady: () => {
      for (const h of handles) {
        h.state = 'ready';
        if (h.job.type === 'ship' || h.job.type === 'scrap') h.ship = shipArt(); else h.struct = flat();
      }
    },
  };
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

  it('structures, scrap and asteroids swap too, with structures baked at their quarter turn', () => {
    const { svc, handles, makeReady } = stubArt();
    const ctx = makeCtx(svc);
    const base = drone('fighter');
    const st = { ...base, kind: 2, shipKind: 'turret', angle: Math.PI / 2, radius: 70 } as SwarmRenderState;
    const scrap = { ...base, kind: 3, shipKind: 'havok', componentIndex: 1, radius: 10 } as SwarmRenderState;
    const rock = { ...base, kind: 0, shipKind: undefined, radius: 40, asteroidResource: 'ice' } as unknown as SwarmRenderState;
    const mirror = { swarm: new Map([[10, st], [11, scrap], [12, rock]]) } as unknown as RenderMirror;
    updateSwarmSprites(mirror, ctx);
    expect([...ctx.sprites.values()].every((s) => s instanceof Graphics)).toBe(true);
    expect(handles.map((h) => h.job.type).sort()).toEqual(['rock', 'scrap', 'struct']);
    expect(handles.find((h) => h.job.type === 'struct')!.job).toMatchObject({ id: 'turret', rot: -Math.PI / 2 });
    makeReady();
    updateSwarmSprites(mirror, ctx);
    expect(ctx.sprites.get('swarm-10')).toBeInstanceOf(MachinedFlatSprite);
    expect(ctx.sprites.get('swarm-11')).toBeInstanceOf(MachinedShipSprite);
    expect(ctx.sprites.get('swarm-12')).toBeInstanceOf(MachinedFlatSprite);
    // The structure's readouts (ETA text etc.) were rebuilt onto the new sprite.
    expect(ctx.sprites.get('swarm-10')!.children.length).toBeGreaterThan(1);
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
