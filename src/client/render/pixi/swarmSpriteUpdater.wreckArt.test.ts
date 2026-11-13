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
import {
  WreckArtState, WreckPieceSprite, WRECK_DISPLAY_OBJECTS_PER_PIECE_MAX, WRECK_RIPPLE_MAX, WRECK_BLAST_MAIN,
  WRECK_RIPPLE_R_MIN, WRECK_RIPPLE_R_MAX, WRECK_CRACK_FRONT_MS, WRECK_GLOW_END_S, wreckGlowTexture,
  WRECK_BLAST_REACH, WRECK_RIPPLE_GAP_MS, wreckGlowAt, type WreckGlow,
} from './wreckArt.js';
import { projectToOutline } from '../../../core/destruction/fractureHull.js';
import { shipHullOutline, shipShapeScale } from '../../../core/geometry/shipHullOutline.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { WRECK_CRACK_MS } from '../../../shared-types/wreckTiming.js';
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

function makeCtx(art: ArtService | null, breaks: number[][], ripples: number[][] = [], rippleCap?: () => number): SwarmSpriteCtx {
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
    wreckArt: new WreckArtState(
      (x, y, r, snap) => breaks.push([x, y, r, snap ? 1 : 0]),
      (x, y, r) => ripples.push([x, y, r]),
      rippleCap,
    ),
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

function maxGlow(ctx: SwarmSpriteCtx): number {
  let m = 0;
  for (const s of ctx.sprites.values()) m = Math.max(m, (s as WreckPieceSprite).glowAlpha());
  return m;
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
      // The hull-art meshes (the cut-edge glow is a mesh on its own small texture).
      const glowTex = (s as WreckPieceSprite).glowTexture();
      const meshes = s!.children.filter((c): c is Mesh => c instanceof Mesh && c.texture !== glowTex);
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

    // A fresh wreck: exactly one break-up burst, near the hull; the cracks
    // nearest the kill point are already hot.
    expect(breaks.length).toBe(1);
    expect(maxGlow(ctx)).toBeGreaterThan(0.9);

    // A second frame builds nothing and fires nothing.
    const before = ctx.shipContainer.children.slice();
    updateSwarmSprites(mirror, ctx);
    expect(ctx.shipContainer.children).toEqual(before);
    expect(breaks.length).toBe(1);
  });

  // Hostile review 2026-11-13 (both reviewers, ~25–30 s of the take): the
  // MIDDLE chunks lost their hull art, darker with a streaky look, while
  // bow and stern looked normal. Measured on the frames: the middle pieces
  // were 0.69 / 0.66 / 0.65 (R/G/B) of the stern's brightness, long after
  // the glow mesh was gone: exactly the old per-piece burnt tint (near the
  // kill point 0x9a8a80 vs 0xd2cac4 far, 0.73 / 0.68 / 0.65). A mid-hull
  // kill put every middle piece at the near end, a dark brown slab with a
  // hard step at each cut once the blast's light had faded.
  it('after cooling, no glow draws and every piece keeps the hull art at about the same brightness', () => {
    const art = battleshipArt();
    const { svc } = stubArt(art);
    const ctx = makeCtx(svc, []);
    const m = mirrorFor(desc(DEATH_TICK), DEATH_TICK);
    ctx.fxNowMs = 10_000;
    updateSwarmSprites(m, ctx);
    ctx.fxNowMs = 10_000 + WRECK_CRACK_MS + WRECK_GLOW_END_S * 1000 + 100;
    updateSwarmSprites(m, ctx);
    const glowTex = wreckGlowTexture();
    const own = new Set(art.frames);
    const tints: number[] = [];
    for (const s of ctx.sprites.values()) {
      expect((s as WreckPieceSprite).glowAlpha()).toBe(0);
      for (const c of s.children) {
        expect(c instanceof Mesh && c.texture === glowTex, 'no glow mesh left over the art').toBe(false);
        if (c instanceof Mesh) { expect(own.has(c.texture)).toBe(true); tints.push(c.tint); }
      }
    }
    expect(tints.length).toBeGreaterThan(3);
    const ch = (t: number, k: number): number => (t >> (16 - 8 * k)) & 255;
    for (let k = 0; k < 3; k++) {
      let lo = 255, hi = 0;
      for (const t of tints) { lo = Math.min(lo, ch(t, k)); hi = Math.max(hi, ch(t, k)); }
      expect(lo / hi, `channel ${k}: no dark slab next to a normal piece`).toBeGreaterThanOrEqual(0.88);
    }
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
    // No hull-art meshes (the glow strip is a mesh on its own small texture).
    expect(s.children.some((c) => c instanceof Mesh && c.texture !== s.glowTexture())).toBe(false);
    expect(maxGlow(ctx)).toBeGreaterThan(0.9);
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
      expect(maxGlow(slow), 'slow motion: still hot').toBeGreaterThan(0.5);

      // Fast: 0.5 s of wall time is 10 s of game time ⇒ dark.
      const fast = makeCtx(null, []);
      wall.mockReturnValue(1_000); fast.fxNowMs = 50_000;
      updateSwarmSprites(m, fast);
      wall.mockReturnValue(1_500); fast.fxNowMs = 60_000;
      updateSwarmSprites(m, fast);
      expect(maxGlow(fast), 'fast: cooled').toBe(0);
    } finally {
      wall.mockRestore();
    }
  });
});

// Owner request 2026-11-13, on the filmed break-up: "The instant split feels a
// bit off. Perhaps some propagating cracks ... and explosions across the
// hull, small and rippling showing internal damage, then it breaks up."
// During the WRECK_CRACK_MS hold the cut edges light up as a crack front runs
// out from the kill point, and small blasts ripple along the cracks.
describe('updateSwarmSprites — cracks spread, then it breaks', () => {
  const T0 = 50_000; // the game clock (fxNow) at death
  const d = desc(DEATH_TICK);

  interface CutEdge { p: number; i: number; near: number; ax: number; ay: number; bx: number; by: number }

  /** Every cut edge of the wreck: piece, edge, its near-end distance from the
   *  kill point and its ends (hull frame; the test pieces sit at their
   *  centroids, unturned, so the hull frame is world space here). */
  function cutEdges(ctx: SwarmSpriteCtx): CutEdge[] {
    const geom = rebuildWreckPieces(d)!;
    const info = ctx.wreckArt!.infoFor(d, geom, 0, { x: 0, y: 0, angle: 0 }, DEATH_TICK, T0);
    const out: CutEdge[] = [];
    geom.forEach((g, p) => {
      const n = g.outline.length;
      for (let i = 0; i < n; i++) {
        if (!g.cutEdges[i]) continue;
        const a = g.outline[i]!, b = g.outline[(i + 1) % n]!;
        const ax = a.x + g.cx, ay = a.y + g.cy, bx = b.x + g.cx, by = b.y + g.cy;
        const near = Math.min(Math.hypot(ax - info.killX, ay - info.killY), Math.hypot(bx - info.killX, by - info.killY));
        out.push({ p, i, near, ax, ay, bx, by });
      }
    });
    return out;
  }

  const heat = (ctx: SwarmSpriteCtx, p: number, i: number): number =>
    (ctx.sprites.get(`swarm-${100 + p}`) as WreckPieceSprite).edgeHeat(i);

  it('cut edges near the kill point glow first; by WRECK_CRACK_MS every cut edge has ignited', () => {
    const ctx = makeCtx(null, []);
    const m = mirrorFor(d, DEATH_TICK);
    ctx.fxNowMs = T0;
    updateSwarmSprites(m, ctx);
    const edges = cutEdges(ctx);
    expect(edges.length).toBeGreaterThan(4);
    let lo = Infinity, hi = 0;
    for (const e of edges) { lo = Math.min(lo, e.near); hi = Math.max(hi, e.near); }
    expect(hi - lo, 'the cracks span the hull').toBeGreaterThan(100);

    // Just after death: only edges near the kill point glow; the far half is dark.
    ctx.fxNowMs = T0 + 100;
    updateSwarmSprites(m, ctx);
    let lit = 0, dark = 0;
    for (const e of edges) {
      const h = heat(ctx, e.p, e.i);
      if (e.near > lo + 0.5 * (hi - lo)) expect(h, `far edge p${e.p}/e${e.i} still dark`).toBe(0);
      if (h > 0.9) lit++;
      if (h === 0) dark++;
    }
    expect(lit, 'the edges at the kill point are hot').toBeGreaterThan(0);
    expect(dark, 'most of the hull has not cracked yet').toBeGreaterThan(0);

    // By the split every cut edge has ignited.
    ctx.fxNowMs = T0 + WRECK_CRACK_MS;
    updateSwarmSprites(m, ctx);
    for (const e of edges) expect(heat(ctx, e.p, e.i), `edge p${e.p}/e${e.i} lit by the split`).toBeGreaterThan(0);

    // Each edge cools from its own ignition: the kill-point edges cool first.
    let nearest = edges[0]!, farthest = edges[0]!;
    for (const e of edges) { if (e.near < nearest.near) nearest = e; if (e.near > farthest.near) farthest = e; }
    ctx.fxNowMs = T0 + 2_000;
    updateSwarmSprites(m, ctx);
    expect(heat(ctx, nearest.p, nearest.i)).toBeLessThan(heat(ctx, farthest.p, farthest.i));
  });

  // Hostile review 2026-11-13: the cracks appeared almost at once, with no
  // visible front. The client first draws a wreck 0.1–0.5 s after the death
  // (the descriptor arrives late), and the front was anchored at the death
  // time, so most of it had already run. A wreck first seen young starts its
  // front from first sight.
  // v7 (fracture v7): every crack lies within a beam or two of the kill
  // point, so "the far edges" are a few hundred units out; what must hold is
  // that 50 ms after first sight only cracks under the kill blast are lit.
  it('a wreck first seen 300 ms after death still shows the front starting at the kill point', () => {
    const ctx = makeCtx(null, []);
    const m = mirrorFor(d, DEATH_TICK + 18); // 18 ticks = 300 ms
    ctx.fxNowMs = T0;
    updateSwarmSprites(m, ctx);
    const edges = cutEdges(ctx);
    const geom = rebuildWreckPieces(d)!;
    let hullR = 0;
    for (const g of geom) hullR = Math.max(hullR, Math.hypot(g.cx, g.cy) + g.radius);
    ctx.fxNowMs = T0 + 50;
    updateSwarmSprites(m, ctx);
    let lit = 0;
    for (const e of edges) {
      const h = heat(ctx, e.p, e.i);
      if (e.near > WRECK_BLAST_REACH * hullR) expect(h, `edge p${e.p}/e${e.i} beyond the kill blast still dark`).toBe(0);
      if (h > 0) lit++;
    }
    expect(lit, 'the front has started at the kill point').toBeGreaterThan(0);
    // The whole spread is still to come: the farthest crack is dark just
    // before the front's full run (from first sight) ends.
    ctx.fxNowMs = T0 + WRECK_CRACK_FRONT_MS * 0.85;
    updateSwarmSprites(m, ctx);
    let farthest = edges[0]!;
    for (const e of edges) if (e.near > farthest.near) farthest = e;
    expect(heat(ctx, farthest.p, farthest.i), 'the farthest crack is not reached yet').toBe(0);
  });

  it('the front reads: a white-hot head runs along each growing crack, gone once every crack is reached', () => {
    const ctx = makeCtx(null, []);
    const m = mirrorFor(d, DEATH_TICK);
    ctx.fxNowMs = T0;
    updateSwarmSprites(m, ctx);
    ctx.fxNowMs = T0 + WRECK_CRACK_FRONT_MS * 0.5;
    updateSwarmSprites(m, ctx);
    let heads = 0;
    for (const s of ctx.sprites.values()) heads += (s as WreckPieceSprite).frontHeads();
    expect(heads, 'heads on the cracks the front is crossing').toBeGreaterThan(0);
    ctx.fxNowMs = T0 + WRECK_CRACK_FRONT_MS + 50;
    updateSwarmSprites(m, ctx);
    heads = 0;
    for (const s of ctx.sprites.values()) heads += (s as WreckPieceSprite).frontHeads();
    expect(heads, 'no head once the front has passed everything').toBe(0);
  });

  it('small blasts ripple along the cracks during the window, under the cap', () => {
    const ripples: number[][] = [];
    const breaks: number[][] = [];
    const ctx = makeCtx(null, breaks, ripples);
    const m = mirrorFor(d, DEATH_TICK);
    let atSplit = -1;
    for (let t = 0; t <= WRECK_CRACK_MS + 600; t += 16) {
      ctx.fxNowMs = T0 + t;
      updateSwarmSprites(m, ctx);
      if (t <= WRECK_CRACK_MS) atSplit = ripples.length;
    }
    expect(ripples.length, 'ripples spawned').toBeGreaterThanOrEqual(3);
    expect(ripples.length).toBeLessThanOrEqual(WRECK_RIPPLE_MAX);
    expect(atSplit, 'all of them before the split').toBe(ripples.length);
    expect(breaks.length, 'still one break-up burst').toBe(1);
    const edges = cutEdges(ctx);
    const geom = rebuildWreckPieces(d)!;
    let hullR = 0;
    for (const g of geom) hullR = Math.max(hullR, Math.hypot(g.cx, g.cy) + g.radius);
    for (const [x, y, r] of ripples) {
      // On a crack (a cut edge), not anywhere over the hull.
      let best = Infinity;
      for (const e of edges) {
        const ex = e.bx - e.ax, ey = e.by - e.ay;
        const t = Math.max(0, Math.min(1, ((x! - e.ax) * ex + (y! - e.ay) * ey) / (ex * ex + ey * ey || 1)));
        best = Math.min(best, Math.hypot(x! - (e.ax + ex * t), y! - (e.ay + ey * t)));
      }
      expect(best, 'ripple on a cut edge').toBeLessThan(1);
      // Clearly visible (review: "no visible ripple explosions" at 0.022–0.04),
      // but well below the kill blast (0.12).
      expect(r! / hullR).toBeGreaterThanOrEqual(WRECK_RIPPLE_R_MIN - 1e-9);
      expect(r! / hullR).toBeLessThanOrEqual(WRECK_RIPPLE_R_MAX + 1e-9);
      expect(WRECK_RIPPLE_R_MIN).toBeGreaterThanOrEqual(0.05);
      expect(WRECK_RIPPLE_R_MAX).toBeLessThanOrEqual(0.07);
      expect(WRECK_RIPPLE_R_MAX).toBeLessThan(WRECK_BLAST_MAIN * 0.6);
    }
  });

  // v7: the cracks all lie within a beam or two of the kill point, so the
  // kill blast's fireballs (out to WRECK_BLAST_REACH of the wreck radius)
  // cover about half of them. Each ripple's own fireball goes off outside
  // that, and they fire one after another.
  it('the ripples go off outside the kill blast, one after another', () => {
    const ripples: number[][] = [];
    const ctx = makeCtx(null, [], ripples);
    const m = mirrorFor(d, DEATH_TICK);
    const at: number[] = [];
    for (let t = 0; t <= WRECK_CRACK_MS; t += 16) {
      ctx.fxNowMs = T0 + t;
      const before = ripples.length;
      updateSwarmSprites(m, ctx);
      for (let k = before; k < ripples.length; k++) at.push(t);
    }
    const geom = rebuildWreckPieces(d)!;
    const info = ctx.wreckArt!.infoFor(d, geom, 0, { x: 0, y: 0, angle: 0 }, DEATH_TICK, T0);
    expect(ripples.length).toBeGreaterThanOrEqual(3);
    for (const [x, y, r] of ripples) {
      const dk = Math.hypot(x! - info.killX, y! - info.killY);
      expect(dk - r!, 'ripple fireball clear of the kill blast').toBeGreaterThanOrEqual(WRECK_BLAST_REACH * info.hullR - 1e-6);
    }
    for (let k = 1; k < at.length; k++) expect(at[k]! - at[k - 1]!, 'ripples in sequence, not together').toBeGreaterThanOrEqual(WRECK_RIPPLE_GAP_MS - 16);
  });

  it('the ripples spread over the window as the front passes, not all at once', () => {
    const ripples: number[][] = [];
    const ctx = makeCtx(null, [], ripples);
    const m = mirrorFor(d, DEATH_TICK);
    ctx.fxNowMs = T0;
    updateSwarmSprites(m, ctx);
    const first = ripples.length;
    for (let t = 16; t <= WRECK_CRACK_MS; t += 16) { ctx.fxNowMs = T0 + t; updateSwarmSprites(m, ctx); }
    expect(ripples.length).toBeGreaterThan(first + 1);
  });

  it('the effects tier caps the ripples (minimal: none)', () => {
    for (const cap of [2, 0]) {
      const ripples: number[][] = [];
      const ctx = makeCtx(null, [], ripples, () => cap);
      const m = mirrorFor(d, DEATH_TICK);
      for (let t = 0; t <= WRECK_CRACK_MS; t += 16) { ctx.fxNowMs = T0 + t; updateSwarmSprites(m, ctx); }
      expect(ripples.length, `cap ${cap}`).toBeLessThanOrEqual(cap);
    }
  });

  it('a late joiner (wreck older than the window) sees no propagation and no ripples', () => {
    const ripples: number[][] = [];
    const ctx = makeCtx(null, [], ripples);
    // First seen 1.5 s after death (90 ticks), past the crack window.
    const m = mirrorFor(d, DEATH_TICK + 90);
    for (let t = 0; t <= 600; t += 16) { ctx.fxNowMs = T0 + t; updateSwarmSprites(m, ctx); }
    expect(ripples.length).toBe(0);
    // Every cut edge shows its current state: already cracked, cooling.
    for (const e of cutEdges(ctx)) expect(heat(ctx, e.p, e.i)).toBeGreaterThan(0);
  });

  it('the front and the ripples run on the game clock (ctx.fxNowMs), not the wall clock', () => {
    const wall = vi.spyOn(performance, 'now');
    try {
      const ripples: number[][] = [];
      const ctx = makeCtx(null, [], ripples);
      const m = mirrorFor(d, DEATH_TICK);
      wall.mockReturnValue(1_000); ctx.fxNowMs = T0;
      updateSwarmSprites(m, ctx);
      wall.mockReturnValue(2_000); ctx.fxNowMs = T0 + 100;
      updateSwarmSprites(m, ctx);
      const edges = cutEdges(ctx);
      const before = edges.map((e) => heat(ctx, e.p, e.i));
      const n = ripples.length;
      // Slow motion: 20 s of wall time pass while the game clock stands still.
      for (let w = 2_000; w <= 22_000; w += 1_000) { wall.mockReturnValue(w); updateSwarmSprites(m, ctx); }
      expect(edges.map((e) => heat(ctx, e.p, e.i))).toEqual(before);
      expect(ripples.length).toBe(n);
      expect(before.some((h) => h === 0), 'the front has not reached the far edges').toBe(true);
    } finally {
      wall.mockRestore();
    }
  });
});

// The filmed v7 break-up (2026-11-13 takes, `showcase-capital-duel`): a
// battleship's 16" salvo kills a heavy cruiser (hull 6000, no shield) side-on
// amidships; capital zoom ~0.17 × (1280/1920). Fracture v7 puts every crack
// within a beam or two of the kill point. Reported:
//  A. "the crack effect doesn't read": the first crack showed ~0.8 s after the
//     kill and spanned the hull in ~0.1 s; no white-hot head; NO visible
//     ripples (at 0.25× they overlapped); the glow stayed saturated orange
//     for ~3 s;
//  B. "a thin sliver goes dark, then fades out": two cracks ~5 px (40–50 u)
//     apart near the hit with a dark streaky strip between them, gone by ~4 s.
// Headless reproduction (pieces arriving over the binary wire 300–400 ms
// after the death): about half the front's run (and every ripple, 409–528 u
// out against a kill blast reaching ~360 u) lay under the kill blast's
// fireballs; the crack behind the head was as white as the head; two
// ripples fired 30 ms apart; one side of a crack lit ~0.5 s after the other
// (per-piece crack distances); the glow was still 0.8 alpha orange 2.7 s in.
// B was no piece: v7 never cuts near-parallel cracks under ~0.56 beams
// (fractureHull.killFocus.test.ts), and every piece keeps its art. It was
// ONE crack opening (~31 u/s after the 1.2 s hold: ~40 u by 2.5 s): each
// piece's glow was centred on its edge, so both halos and cores spilled
// over the gap and read as a dark strip "piece" that faded with the glow.
describe('updateSwarmSprites — the filmed v7 break-up (heavy cruiser, 16" salvo amidships)', () => {
  const T0 = 80_000;
  const SEEDS = [3, 7, 12, 21, 33];
  const hc = shipHullOutline(getShipKind('heavy-cruiser'));
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of hc) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  /** The starboard edge amidships (the side facing the battleship). */
  const kill = projectToOutline(hc, { x: 1e4, y: (minY + maxY) / 2 });
  const filmed = (seed: number): WreckDescriptor => ({
    wreckId: 9, parentKind: 'heavy-cruiser', seed, killX: kill.x, killY: kill.y,
    killBlowDamage: 1.39, recentDamageRate: 2.4, snapChance: 0, algoVersion: FRACTURE_ALGO_VERSION, deathTick: DEATH_TICK,
  });

  interface Run {
    ctx: SwarmSpriteCtx; mirror: RenderMirror; d: WreckDescriptor; geom: ReturnType<typeof rebuildWreckPieces>;
    hullR: number; ripples: number[][]; rippleAt: number[];
    /** Advance to `t` game ms after first sight (pieces arrive on the way). */
    to(t: number): void;
  }

  /** The wreck first drawn 300 ms after the death; its other pieces arrive
   *  over the next 100 ms (out-of-interest binary cadence), as filmed. */
  function film(seed: number, art: ArtService | null = null): Run {
    const d = filmed(seed);
    const geom = rebuildWreckPieces(d);
    const ripples: number[][] = [];
    const rippleAt: number[] = [];
    const ctx = makeCtx(art, [], ripples, () => WRECK_RIPPLE_MAX);
    const swarm = new Map<number, SwarmRenderState>();
    const mirror = { swarm, wrecks: new Map([[d.wreckId, d]]) } as unknown as RenderMirror;
    let hullR = 0;
    for (const g of geom) hullR = Math.max(hullR, Math.hypot(g.cx, g.cy) + g.radius);
    let now = -1;
    const run: Run = {
      ctx, mirror, d, geom, hullR, ripples, rippleAt,
      to(t: number) {
        for (let s = Math.max(0, now + 1); s <= t; s += 16) step(Math.min(s, t));
        if (now < t) step(t);
      },
    };
    function step(t: number): void {
      geom.forEach((g, i) => {
        if (t >= i * (100 / Math.max(1, geom.length - 1)) && !swarm.has(200 + i)) {
          const p = piece(i, g.cx, g.cy, g.radius, DEATH_TICK + 18 + Math.round(t / (1000 / 60)));
          p.shipKind = 'heavy-cruiser';
          p.wreckId = d.wreckId;
          swarm.set(200 + i, p);
        }
      });
      ctx.fxNowMs = T0 + t;
      const n = ripples.length;
      updateSwarmSprites(mirror, ctx);
      for (let k = n; k < ripples.length; k++) rippleAt.push(t);
      now = t;
    }
    return run;
  }

  const sprite = (r: Run, i: number): WreckPieceSprite => r.ctx.sprites.get(`swarm-${200 + i}`) as WreckPieceSprite;
  /** Every cut edge: piece, edge, its ends' distances from the kill point. */
  function edgesOf(r: Run): Array<{ p: number; i: number; near: number; far: number }> {
    const kx = r.d.killX * shipShapeScale(getShipKind('heavy-cruiser')), ky = -r.d.killY * shipShapeScale(getShipKind('heavy-cruiser'));
    const out: Array<{ p: number; i: number; near: number; far: number }> = [];
    r.geom.forEach((g, p) => {
      const n = g.outline.length;
      for (let i = 0; i < n; i++) {
        if (!g.cutEdges[i]) continue;
        const a = g.outline[i]!, b = g.outline[(i + 1) % n]!;
        const da = Math.hypot(a.x + g.cx - kx, a.y + g.cy - ky), db = Math.hypot(b.x + g.cx - kx, b.y + g.cy - ky);
        out.push({ p, i, near: Math.min(da, db), far: Math.max(da, db) });
      }
    });
    return out;
  }

  it('the cracks race out from the kill point over ~0.8–1 s from first sight, most of it where the kill blast does not cover them, a white-hot head on each', () => {
    for (const seed of SEEDS) {
      const r = film(seed);
      const edges = edgesOf(r);
      const reach = WRECK_BLAST_REACH * r.hullR;
      let seen = -1, all = -1, headFrames = 0, frames = 0;
      for (let t = 0; t <= 1300; t += 16) {
        r.to(t);
        let lit = 0, litOut = 0;
        for (const e of edges) {
          const h = sprite(r, e.p)?.edgeHeat(e.i) ?? 0;
          if (h > 0) { lit++; if (e.near > reach) litOut++; }
        }
        if (litOut > 0 && seen < 0) seen = t;
        if (lit === edges.length && all < 0) all = t;
        if (seen >= 0 && all < 0) {
          frames++;
          let heads = 0;
          for (let i = 0; i < r.geom.length; i++) heads += sprite(r, i).frontHeads();
          if (heads > 0) headFrames++;
        }
      }
      expect(all, `seed ${seed}: every crack lit by 1 s after first sight`).toBeLessThanOrEqual(1000);
      expect(all, `seed ${seed}: ... not before 0.8 s`).toBeGreaterThanOrEqual(800);
      // Before: the front was paced evenly over crack distance and only
      // ~0.5 s of it ran outside the kill blast.
      expect(all - seen, `seed ${seed}: the front runs visibly (outside the kill blast) for most of its time`).toBeGreaterThanOrEqual(650);
      expect(headFrames / frames, `seed ${seed}: a head is running while the front is visible`).toBeGreaterThan(0.9);
    }
    // The head reads: white-hot at the tip, the crack behind it already
    // orange (before: still near-white 0.2 s behind the tip).
    const g: WreckGlow = { color: 0, alpha: 0 };
    wreckGlowAt(0, g);
    const tipG = (g.color >> 8) & 255;
    wreckGlowAt(0.2, g);
    expect(tipG, 'the head is white-hot').toBeGreaterThan(0xe0);
    expect((g.color >> 8) & 255, 'the crack 0.2 s behind it is orange').toBeLessThan(0xa8);
  });

  it('both sides of a crack light together', () => {
    for (const seed of SEEDS) {
      const r = film(seed);
      // Coincident cut edges on two pieces (hull frame).
      const key = (x: number, y: number): string => `${Math.round(x * 4)},${Math.round(y * 4)}`;
      const owner = new Map<string, Array<{ p: number; i: number }>>();
      r.geom.forEach((gp, p) => {
        const n = gp.outline.length;
        for (let i = 0; i < n; i++) {
          if (!gp.cutEdges[i]) continue;
          const a = gp.outline[i]!, b = gp.outline[(i + 1) % n]!;
          const ka = key(a.x + gp.cx, a.y + gp.cy), kb = key(b.x + gp.cx, b.y + gp.cy);
          const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
          if (!owner.has(k)) owner.set(k, []);
          owner.get(k)!.push({ p, i });
        }
      });
      let pairs = 0;
      for (const t of [150, 300, 450, 600, 750, 900]) {
        r.to(t);
        for (const sides of owner.values()) {
          if (sides.length !== 2) continue;
          pairs++;
          const [a, b] = sides as [{ p: number; i: number }, { p: number; i: number }];
          const ha = sprite(r, a.p).edgeHeat(a.i), hb = sprite(r, b.p).edgeHeat(b.i);
          expect((ha > 0) === (hb > 0), `seed ${seed} t ${t}: one side of a crack lit, the other dark`).toBe(true);
        }
      }
      expect(pairs).toBeGreaterThan(20);
    }
  });

  it('a handful of ripples go off along the cracks one after another, each outside the kill blast', () => {
    for (const seed of SEEDS) {
      const r = film(seed);
      r.to(1300);
      const kx = r.d.killX * shipShapeScale(getShipKind('heavy-cruiser')), ky = -r.d.killY * shipShapeScale(getShipKind('heavy-cruiser'));
      expect(r.ripples.length, `seed ${seed}: a handful`).toBeGreaterThanOrEqual(3);
      expect(r.ripples.length).toBeLessThanOrEqual(WRECK_RIPPLE_MAX);
      for (const [x, y, rr] of r.ripples) {
        expect(Math.hypot(x! - kx, y! - ky) - rr!, `seed ${seed}: ripple fireball outside the kill blast`).toBeGreaterThanOrEqual(WRECK_BLAST_REACH * r.hullR - 1e-6);
      }
      for (let k = 1; k < r.rippleAt.length; k++) {
        expect(r.rippleAt[k]! - r.rippleAt[k - 1]!, `seed ${seed}: in sequence (before: two 30 ms apart)`).toBeGreaterThanOrEqual(WRECK_RIPPLE_GAP_MS - 16);
      }
      expect(r.rippleAt[r.rippleAt.length - 1]! - r.rippleAt[0]!, `seed ${seed}: spread over the run`).toBeGreaterThanOrEqual(300);
    }
  });

  it('the glow cools noticeably within ~3 s: a dull red, not saturated orange', () => {
    for (const seed of SEEDS) {
      const r = film(seed);
      r.to(3000);
      let hot = 0;
      for (let i = 0; i < r.geom.length; i++) hot = Math.max(hot, sprite(r, i).glowAlpha());
      expect(hot, `seed ${seed}: hottest crack 3 s after first sight (before: 0.8)`).toBeLessThan(0.6);
    }
  });

  it('B: no glow is drawn outside its own piece, so an opening crack shows a clean gap (no dark "sliver")', () => {
    for (const seed of SEEDS) {
      const r = film(seed);
      for (const t of [1300, 2500, 3500]) {
        r.to(t);
        r.geom.forEach((g, i) => {
          const pos = sprite(r, i).glowPositions();
          if (pos === null) return;
          for (let q = 0; q < pos.length; q += 8) {
            // A collapsed quad (not lit, or a finished head) draws nothing.
            const area = Math.abs((pos[q + 2]! - pos[q]!) * (pos[q + 5]! - pos[q + 1]!) - (pos[q + 4]! - pos[q]!) * (pos[q + 3]! - pos[q + 1]!))
              + Math.abs((pos[q + 4]! - pos[q]!) * (pos[q + 7]! - pos[q + 1]!) - (pos[q + 6]! - pos[q]!) * (pos[q + 5]! - pos[q + 1]!));
            if (area < 1e-3) continue;
            for (let c = 0; c < 8; c += 2) {
              // Glow positions are Pixi-down; the outline is math-up.
              const out = distOutside(g.outline, pos[q + c]!, -pos[q + c + 1]!);
              expect(out, `seed ${seed} t ${t}: piece ${i} glow vertex ${out.toFixed(1)} u outside the piece`).toBeLessThan(1);
            }
          }
        });
      }
    }
  });

  it('B: a wreck piece never fades or vanishes: its hull art stays drawn, at full alpha, long after the glow', () => {
    const art = battleshipArt();
    const { svc } = stubArt(art);
    const r = film(7, svc);
    const own = new Set(art.frames);
    for (const t of [500, 2500, 4000, 6000, 30_000, 120_000]) {
      r.to(t);
      for (let i = 0; i < r.geom.length; i++) {
        const s = sprite(r, i);
        expect(s, `t ${t}: piece ${i} still has a sprite`).toBeInstanceOf(WreckPieceSprite);
        expect(s.visible && s.renderable && s.alpha === 1, `t ${t}: piece ${i} drawn at full alpha`).toBe(true);
        const meshes = s.children.filter((c) => c instanceof Mesh && own.has(c.texture));
        expect(meshes.length, `t ${t}: piece ${i} keeps its hull art`).toBeGreaterThan(0);
        for (const m of meshes) expect(m.visible && m.alpha === 1, `t ${t}: piece ${i} art mesh not faded`).toBe(true);
      }
    }
  });
});

/** How far (x, y) lies outside the polygon (0 when inside or on it). */
function distOutside(poly: ReadonlyArray<{ x: number; y: number }>, x: number, y: number): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    const ex = b.x - a.x, ey = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((x - a.x) * ex + (y - a.y) * ey) / (ex * ex + ey * ey || 1)));
    best = Math.min(best, Math.hypot(x - (a.x + ex * t), y - (a.y + ey * t)));
  }
  return inside ? 0 : best;
}
