/**
 * Structure break-up T5 through the swarm updater: a structure's wreck
 * pieces draw the plain polygon until the structure's own bake is ready,
 * then swap to it (no ship bake asked, no new bake job kind); with art off
 * they stay plain.
 */
import { describe, expect, it } from 'vitest';
import { Container, Graphics, Mesh, Texture, TextureSource } from 'pixi.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import { WreckGeometryStore, rebuildWreckPieces } from '../../net/wreckGeometryStore.js';
import { WreckArtState, WreckPieceSprite } from './wreckArt.js';
import { structArtAsShipArt } from './wreckPieceArtHandle.js';
import type { ArtHandle, ArtService, StructArt } from '../art/ArtService.js';
import type { RenderMirror, SwarmRenderState, PoseRingEntry } from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';
import { FRACTURE_ALGO_VERSION } from '../../../core/destruction/fractureHull.js';
import { WRECK_STRUCTURE_PARENT_KIND, type WreckDescriptor } from '../../../shared-types/messages/wreckDescriptor.js';

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 } as PoseRingEntry);
  return ring;
}

const tex = new Texture({ source: new TextureSource({ width: 300, height: 300 }) });
const STRUCT: StructArt = { tex, albedo: tex, w: 300, h: 300, density: 0.5, navLights: [] };

function stubArt(): { svc: ArtService; asked: string[]; handle: ArtHandle } {
  const asked: string[] = [];
  const handle = { key: 's', job: { type: 'struct', id: 'capital', rot: 0, lit: false }, rig: {}, state: 'queued', ship: null, struct: null } as unknown as ArtHandle;
  const svc = {
    lightRig: {},
    ship: (id: string) => { asked.push(`ship:${id}`); return handle; },
    struct: (id: string) => { asked.push(`struct:${id}`); return handle; },
  } as unknown as ArtService;
  return { svc, asked, handle };
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
    art: { art, handles: new Map(), sunAz: 0.4 },
    slewDtSec: 1 / 60,
    wrecks: new WreckGeometryStore(),
    wreckArt: new WreckArtState(),
  } as SwarmSpriteCtx;
}

const DESC: WreckDescriptor = {
  wreckId: 9, parentKind: WRECK_STRUCTURE_PARENT_KIND, structure: { k: 'capital' }, seed: 31,
  killX: 0, killY: 0, killBlowDamage: 0.5, recentDamageRate: 0.2, snapChance: 0, algoVersion: FRACTURE_ALGO_VERSION, deathTick: 100,
};

function mirror(): RenderMirror {
  const swarm = new Map<number, SwarmRenderState>();
  rebuildWreckPieces(DESC)!.forEach((g, i) => swarm.set(200 + i, {
    x: g.cx, y: g.cy, vx: 0, vy: 0, angle: 0, angvel: 0, prevX: g.cx, prevY: g.cy, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: emptyPoseRing(), ringHead: 0, radius: g.radius, kind: 4, shipKind: 'fighter', componentIndex: i, wreckId: DESC.wreckId,
    sleeping: false, lastUpdateTick: 103,
  } as SwarmRenderState));
  return { swarm, wrecks: new Map([[DESC.wreckId, DESC]]) } as unknown as RenderMirror;
}

const hasArtMesh = (s: Container | undefined): boolean => s!.children.some((c) => c instanceof Mesh && c.texture === tex);
const isPlain = (s: Container | undefined): boolean => s!.children.some((c) => c instanceof Graphics);

describe('updateSwarmSprites — structure wreck pieces wear the structure\'s art (T5)', () => {
  it('plain until the structure bake is ready, then swapped to it; only the structure\'s bake is asked', () => {
    const { svc, asked, handle } = stubArt();
    const ctx = makeCtx(svc);
    const m = mirror();
    updateSwarmSprites(m, ctx);
    const keys = [...m.swarm!.keys()].map((id) => `swarm-${id}`);
    for (const k of keys) {
      expect(ctx.sprites.get(k)).toBeInstanceOf(WreckPieceSprite);
      expect(isPlain(ctx.sprites.get(k)), k).toBe(true);
    }
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((a) => a === 'struct:capital')).toBe(true);

    handle.state = 'ready';
    handle.struct = STRUCT;
    updateSwarmSprites(m, ctx);
    const first = keys.map((k) => ctx.sprites.get(k));
    for (const s of first) {
      expect((s as WreckPieceSprite).art).toBe(structArtAsShipArt(STRUCT));
      expect(hasArtMesh(s)).toBe(true);
    }
    // A further frame keeps the same sprites (identity compare, no rebuild).
    updateSwarmSprites(m, ctx);
    keys.forEach((k, i) => expect(ctx.sprites.get(k)).toBe(first[i]));
  });

  it('art off: the plain polygon, no bake asked', () => {
    const ctx = makeCtx(null);
    const m = mirror();
    updateSwarmSprites(m, ctx);
    for (const id of m.swarm!.keys()) expect(isPlain(ctx.sprites.get(`swarm-${id}`))).toBe(true);
  });
});
