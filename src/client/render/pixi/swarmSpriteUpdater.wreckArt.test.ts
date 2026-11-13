/**
 * Capital destruction S3 — wreck pieces draw the DEAD SHIP'S OWN baked art.
 *
 * With Machined art on, each piece is a `WreckPieceSprite`: one Mesh per hull
 * tile the piece covers, each textured with the parent kind's existing tile
 * texture (no new bake, no new texture page per wreck), plus one glow stroke
 * on its cut edges while they are hot. The break-up fires once per fresh
 * wreck (dust, shards, flash); a late joiner sees it already cool.
 */
import { describe, it, expect, vi } from 'vitest';
import { Container, GlProgram, Mesh, Rectangle, Texture, TextureSource } from 'pixi.js';
import { LitShipMesh } from '../art/litShipShader.js';
import { litPass } from '../art/litPass.js';
import { LOOK_NIGHT } from '../art/lightingSettings.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import { WreckGeometryStore, rebuildWreckPieces } from '../../net/wreckGeometryStore.js';
import { WreckArtState, WreckPieceSprite, WRECK_DISPLAY_OBJECTS_PER_PIECE_MAX } from './wreckArt.js';
import type { ArtHandle, ArtService, ShipArt } from '../art/ArtService.js';
import type { RenderMirror, SwarmRenderState, PoseRingEntry } from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';
import { FRACTURE_ALGO_VERSION } from '../../../core/destruction/fractureHull.js';
import { CLIENT_COUNT_BUDGETS } from '../../../shared-types/perf/perfBudgets.js';
import type { WreckDescriptor } from '../../../shared-types/messages/snapshotMessages.js';

// Compiling the lit GLSL needs a WebGL context (none under Node).
vi.spyOn(GlProgram, 'from').mockImplementation(() => ({}) as GlProgram);

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 } as PoseRingEntry);
  return ring;
}

const TILES = 3;
const SUN_STEPS = 16;
const W = 300, H = 1400, TILE_H = 512;

/** The parent kind's baked art: sun-major frames, one texture per tile. */
function battleshipArt(): ShipArt {
  const frames: Texture[] = [];
  for (let s = 0; s < SUN_STEPS; s++) {
    for (let t = 0; t < TILES; t++) {
      const rows = Math.min(TILE_H, H - t * TILE_H);
      frames.push(new Texture({ source: new TextureSource({ width: W, height: rows }) }));
    }
  }
  return { frames, w: W, h: H, tiles: TILES, tileH: TILE_H, density: 0.2, nozzles: [], navLights: [] };
}

function stubArt(art: ShipArt): { svc: ArtService; asked: string[] } {
  const asked: string[] = [];
  const handles = new Map<string, ArtHandle>();
  const svc = {
    lightRig: {},
    ship: (id: string, paint?: number) => {
      asked.push(id);
      let h = handles.get(id);
      if (!h) {
        h = { key: id, job: { type: 'ship', id, paint }, rig: {} as ArtHandle['rig'], state: 'ready', ship: art, struct: null };
        handles.set(id, h);
      }
      return h;
    },
  } as unknown as ArtService;
  return { svc, asked };
}

function makeCtx(art: ArtService | null, breaks: number[][]): SwarmSpriteCtx {
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
    wreckArt: new WreckArtState((x, y, r, snap) => breaks.push([x, y, r, snap ? 1 : 0])),
  } as SwarmSpriteCtx;
}

const DEATH_TICK = 5000;
const desc = (deathTick: number | undefined): WreckDescriptor => ({
  wreckId: 3, parentKind: 'battleship', seed: 11, killX: 0, killY: -400,
  killBlowDamage: 2, recentDamageRate: 1, snapChance: 0, algoVersion: FRACTURE_ALGO_VERSION,
  ...(deathTick !== undefined ? { deathTick } : {}),
});

function piece(index: number, x: number, y: number, radius: number, tick: number): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: x, prevY: y, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: emptyPoseRing(), ringHead: 0,
    radius, kind: 4, shipKind: 'battleship', componentIndex: index, wreckId: 3,
    sleeping: false, lastUpdateTick: tick,
  } as SwarmRenderState;
}

function mirrorFor(d: WreckDescriptor, tick: number): RenderMirror {
  const geom = rebuildWreckPieces(d);
  const swarm = new Map<number, SwarmRenderState>();
  geom.forEach((g, i) => swarm.set(100 + i, piece(i, g.cx, g.cy, g.radius, tick)));
  return { swarm, wrecks: new Map([[d.wreckId, d]]) } as unknown as RenderMirror;
}

function countDisplayObjects(c: Container): number {
  let n = 1;
  for (const ch of c.children) n += countDisplayObjects(ch);
  return n;
}

describe('updateSwarmSprites — capital wreck art (S3)', () => {
  it('each piece is textured with the parent kind\'s own baked tile textures, within the count budget', () => {
    const art = battleshipArt();
    const { svc, asked } = stubArt(art);
    const breaks: number[][] = [];
    const ctx = makeCtx(svc, breaks);
    const mirror = mirrorFor(desc(DEATH_TICK), DEATH_TICK + 3);
    updateSwarmSprites(mirror, ctx);

    const n = mirror.swarm!.size;
    expect(asked.every((k) => k === 'battleship'), 'only the parent kind\'s art is asked for').toBe(true);
    const own = new Set(art.frames);
    const used = new Set<Texture>();
    let objects = 0;
    for (let i = 0; i < n; i++) {
      const s = ctx.sprites.get(`swarm-${100 + i}`);
      expect(s, `piece ${i} drawn`).toBeInstanceOf(WreckPieceSprite);
      const meshes = s!.children.filter((c): c is Mesh => c instanceof Mesh);
      expect(meshes.length, `piece ${i} has textured meshes`).toBeGreaterThan(0);
      for (const m of meshes) {
        expect(own.has(m.texture), 'mesh uses one of the parent\'s frames').toBe(true);
        used.add(m.texture);
        // Burnt: slightly darker than the art, never the old near-black slab
        // (money-shot review: 23–55 % read as flat dark grey).
        const t = m.tint;
        const sum = ((t >> 16) & 255) + ((t >> 8) & 255) + (t & 255);
        expect(sum).toBeLessThan(3 * 0xe0);
        expect(sum).toBeGreaterThan(3 * 0x88);
      }
      const objs = countDisplayObjects(s!);
      expect(objs).toBeLessThanOrEqual(WRECK_DISPLAY_OBJECTS_PER_PIECE_MAX);
      objects += objs;
      expect(s!.filters ?? null, 'no filter (would break batching)').toBeNull();
    }
    // One sun frame's tiles only: every piece batches over ≤ 3 textures (the
    // batcher takes 16), and no texture was made for the wreck.
    expect(used.size).toBeLessThanOrEqual(TILES);
    // A wreck added to the busiest calibrated scene stays inside the budget.
    const b = CLIENT_COUNT_BUDGETS['fleet-fight/baked']!;
    const measuredMax = 5592; // `measured` above: desktop objects 4920–5592
    expect(measuredMax + objects).toBeLessThanOrEqual(b.displayObjects);

    // A fresh wreck: exactly one break-up burst, near the hull, glow hot.
    expect(breaks.length).toBe(1);
    const glow = (ctx.sprites.get('swarm-100') as WreckPieceSprite).glowAlpha();
    expect(glow).toBeGreaterThan(0.9);

    // A second frame builds nothing and fires nothing.
    const before = ctx.shipContainer.children.slice();
    updateSwarmSprites(mirror, ctx);
    expect(ctx.shipContainer.children).toEqual(before);
    expect(breaks.length).toBe(1);
  });

  it('a late joiner sees the wreck cool: no burst, no glow (from the descriptor\'s death tick)', () => {
    const { svc } = stubArt(battleshipArt());
    const breaks: number[][] = [];
    const ctx = makeCtx(svc, breaks);
    updateSwarmSprites(mirrorFor(desc(DEATH_TICK), DEATH_TICK + 60 * 60), ctx);
    expect(breaks.length).toBe(0);
    for (const s of ctx.sprites.values()) expect((s as WreckPieceSprite).glowAlpha()).toBe(0);
  });

  it('no death tick in the descriptor: starts cool', () => {
    const { svc } = stubArt(battleshipArt());
    const breaks: number[][] = [];
    const ctx = makeCtx(svc, breaks);
    updateSwarmSprites(mirrorFor(desc(undefined), DEATH_TICK), ctx);
    expect(breaks.length).toBe(0);
    for (const s of ctx.sprites.values()) expect((s as WreckPieceSprite).glowAlpha()).toBe(0);
  });

  it('GPU-lit art (the player look): every piece is lit by the lit shader, mapped in the hull frame', () => {
    // Money-shot review: with `shiplight=high` the pieces drew the raw albedo
    // slice of the lit maps through the default shader (no sun, no normals)
    // under a dark burnt tint: flat dark-grey slabs. A lit piece must be a
    // LitShipMesh registered with the light pass.
    const PW = 2048, PH = 2048;
    const page = new TextureSource({ width: PW, height: PH });
    const frames: Texture[] = [];
    for (let t = 0; t < TILES; t++) {
      const rows = Math.min(TILE_H, H - t * TILE_H);
      frames.push(new Texture({ source: page, frame: new Rectangle(64 + t * 40, 100 + t * TILE_H, W, rows) }));
    }
    const art: ShipArt = { frames, w: W, h: H, tiles: TILES, tileH: TILE_H, density: 0.2, nozzles: [], navLights: [], lit: { w: W, h: H, ppu: 0.2, maxH: 30, emisMax: 1 } };
    const prev = litPass.settings;
    const before = litPass.count;
    litPass.settings = LOOK_NIGHT;
    try {
      const { svc } = stubArt(art);
      const ctx = makeCtx(svc, []);
      const d = desc(DEATH_TICK);
      const mirror = mirrorFor(d, DEATH_TICK + 3);
      updateSwarmSprites(mirror, ctx);
      const geom = rebuildWreckPieces(d)!;
      let lit = 0;
      for (let i = 0; i < geom.length; i++) {
        const s = ctx.sprites.get(`swarm-${100 + i}`) as WreckPieceSprite;
        expect(s.artMode(), `piece ${i}`).toBe('lit');
        const meshes = s.children.filter((c): c is LitShipMesh => c instanceof LitShipMesh);
        expect(meshes.length).toBeGreaterThan(0);
        for (const m of meshes) {
          lit++;
          // The mesh sits in the HULL's frame: offset back to the centroid.
          expect(m.position.x).toBeCloseTo(-geom[i]!.cx);
          expect(m.position.y).toBeCloseTo(geom[i]!.cy);
          // UVs land inside the tile's slice-A rectangle on the page.
          const f = m.tile.tex.frame;
          const uv = m.geometry.getBuffer('aUV').data as Float32Array;
          for (let k = 0; k < uv.length; k += 2) {
            expect(uv[k]! * PW).toBeGreaterThanOrEqual(f.x - 1e-3);
            expect(uv[k]! * PW).toBeLessThanOrEqual(f.x + f.width + 1e-3);
            expect(uv[k + 1]! * PH).toBeGreaterThanOrEqual(f.y - 1e-3);
            expect(uv[k + 1]! * PH).toBeLessThanOrEqual(f.y + f.height + 1e-3);
          }
          const sum = ((m.tint >> 16) & 255) + ((m.tint >> 8) & 255) + (m.tint & 255);
          expect(sum, 'slightly darkened, not black').toBeGreaterThan(3 * 0x88);
        }
      }
      expect(litPass.count - before, 'every lit piece mesh is registered with the light pass').toBe(lit);
      for (const s of ctx.sprites.values()) s.destroy({ children: true });
      expect(litPass.count, 'destroyed pieces leave the light pass').toBe(before);
    } finally {
      litPass.settings = prev;
    }
  });

  it('classic look (no art): plain pieces still glow on their cut edges', () => {
    const breaks: number[][] = [];
    const ctx = makeCtx(null, breaks);
    updateSwarmSprites(mirrorFor(desc(DEATH_TICK), DEATH_TICK), ctx);
    const s = ctx.sprites.get('swarm-100') as WreckPieceSprite;
    expect(s).toBeInstanceOf(WreckPieceSprite);
    expect(s.children.some((c) => c instanceof Mesh)).toBe(false);
    expect(s.glowAlpha()).toBeGreaterThan(0.9);
    expect(breaks.length).toBe(1);
  });

  // Robustness check 2026-11-13 (speed × destruction): the cut-edge glow is
  // presentation, so it follows the GAME speed (the renderer's fxNow, handed in
  // as ctx.fxNowMs), not the wall clock. In slow motion it must cool slowly; at
  // 4× it must cool fast. Before the fix the updater aged it on performance.now().
  it('the cut-edge glow cools on the game clock (ctx.fxNowMs), not the wall clock', () => {
    const wall = vi.spyOn(performance, 'now');
    try {
      // Slow motion: 10 s of wall time is only 0.5 s of game time ⇒ still hot.
      const slow = makeCtx(null, []);
      const m = mirrorFor(desc(DEATH_TICK), DEATH_TICK);
      wall.mockReturnValue(1_000); slow.fxNowMs = 50_000;
      updateSwarmSprites(m, slow);
      wall.mockReturnValue(11_000); slow.fxNowMs = 50_500;
      updateSwarmSprites(m, slow);
      expect((slow.sprites.get('swarm-100') as WreckPieceSprite).glowAlpha(), 'slow motion: still hot').toBeGreaterThan(0.5);

      // Fast: 0.5 s of wall time is 10 s of game time ⇒ dark.
      const fast = makeCtx(null, []);
      wall.mockReturnValue(1_000); fast.fxNowMs = 50_000;
      updateSwarmSprites(m, fast);
      wall.mockReturnValue(1_500); fast.fxNowMs = 60_000;
      updateSwarmSprites(m, fast);
      expect((fast.sprites.get('swarm-100') as WreckPieceSprite).glowAlpha(), 'fast: cooled').toBe(0);
    } finally {
      wall.mockRestore();
    }
  });
});
