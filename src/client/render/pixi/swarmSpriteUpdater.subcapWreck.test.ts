/**
 * Sub-capital break-up, slice 4: the client's QUIET look (plan
 * `subcapital-breakup.md`; docs/architecture/capital-destruction.md
 * "Sub-capital profile").
 *
 * Owner (2026-11-13): "far less flashy and expensive for smaller vessels as
 * it'll be happening a lot ... If the smaller ships are over the top then
 * it'll spoil how cool capitals are ... use the same systems, just make it
 * use less effects, the glow simpler, only a few parts."
 *
 * The wreck's `parentKind` picks its destruction profile, and the profile's
 * `fx` block drives the renderer: a sub-cap wreck plays no break-up burst, no
 * kill blasts, no crack front and no ripples; its ship's normal death
 * explosion stays; its cut edges glow once, core only, and are dark by
 * `glowSeconds` (none at the minimal effects tier); each piece is one art
 * mesh plus that short-lived glow, and a settled piece does no per-frame
 * tint or texture writes. Capital behaviour is locked by the existing
 * wreck-art tests (`swarmSpriteUpdater.wreckArt.test.ts`).
 */
import { describe, it, expect } from 'vitest';
import { Container, Mesh, Texture, TextureSource } from 'pixi.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import { WreckGeometryStore, rebuildWreckPieces } from '../../net/wreckGeometryStore.js';
import { WreckArtState, WreckPieceSprite, hullDeathBlastReplaced } from './wreckArt.js';
import { radarCategoryForSwarm } from '../halo/arrowGraphics.js';
import { FarZoomIcons } from './FarZoomIcons.js';
import { DESTRUCTION_PROFILES } from '../../../shared-types/shipScale/destruction.js';
import type { ArtHandle, ArtService, ShipArt } from '../art/ArtService.js';
import type { RenderMirror, SwarmRenderState, PoseRingEntry } from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';
import { FRACTURE_ALGO_VERSION } from '../../../core/destruction/fractureHull.js';
import type { WreckDescriptor } from '../../../shared-types/messages/snapshotMessages.js';

const SUB = DESTRUCTION_PROFILES.subcap.fx;
const GLOW_MS = SUB.glowSeconds * 1000;

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 } as PoseRingEntry);
  return ring;
}

const SUN_STEPS = 16;
/** A small ship's baked art: ONE tile, one texture per sun step. */
function fighterArt(): ShipArt {
  const frames: Texture[] = [];
  for (let s = 0; s < SUN_STEPS; s++) frames.push(new Texture({ source: new TextureSource({ width: 64, height: 64 }) }));
  return { frames, w: 64, h: 64, tiles: 1, tileH: 64, density: 1, nozzles: [], navLights: [] };
}

function stubArt(art: ShipArt): ArtService {
  const handles = new Map<string, ArtHandle>();
  return {
    lightRig: {},
    ship: (id: string) => {
      let h = handles.get(id);
      if (!h) {
        h = { key: id, job: { type: 'ship', id }, rig: {} as ArtHandle['rig'], state: 'ready', ship: art, struct: null };
        handles.set(id, h);
      }
      return h;
    },
  } as unknown as ArtService;
}

interface Sinks { breaks: number; blasts: number; ripples: number }

function makeCtx(art: ArtService | null, sinks: Sinks, quality = 'high'): SwarmSpriteCtx {
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
    // The renderer's sinks, gated the way PixiRenderer gates them.
    wreckArt: new WreckArtState(
      (_x, _y, _r, _snap, _seed, fx) => {
        if (fx.breakBurst) sinks.breaks++;
        if (fx.killBlasts) sinks.blasts++;
      },
      () => { sinks.ripples++; },
      () => 7,
      () => quality,
    ),
  } as SwarmSpriteCtx;
}

const DEATH_TICK = 5000;
function desc(parentKind: string, seed: number, deathTick: number | undefined = DEATH_TICK): WreckDescriptor {
  return {
    wreckId: 7, parentKind, seed, killX: 0, killY: -4,
    killBlowDamage: 2, recentDamageRate: 1, snapChance: 0.2, algoVersion: FRACTURE_ALGO_VERSION,
    ...(deathTick !== undefined ? { deathTick } : {}),
  };
}

function mirrorFor(d: WreckDescriptor, tick: number): RenderMirror {
  const geom = rebuildWreckPieces(d);
  const swarm = new Map<number, SwarmRenderState>();
  geom.forEach((g, i) => swarm.set(100 + i, {
    x: g.cx, y: g.cy, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: g.cx, prevY: g.cy, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: emptyPoseRing(), ringHead: 0,
    radius: g.radius, kind: 4, shipKind: d.parentKind, componentIndex: i, wreckId: d.wreckId,
    sleeping: false, lastUpdateTick: tick,
  } as SwarmRenderState));
  return { swarm, wrecks: new Map([[d.wreckId, d]]) } as unknown as RenderMirror;
}

function pieces(ctx: SwarmSpriteCtx): WreckPieceSprite[] {
  return [...ctx.sprites.values()].filter((s): s is WreckPieceSprite => s instanceof WreckPieceSprite);
}

/** Counts writes to an accessor property on one object (the getter kept). */
function countSets(obj: object, prop: string, what: string): { what: string; n: number } {
  let proto: object | null = obj;
  let d: PropertyDescriptor | undefined;
  while (proto !== null && (d = Object.getOwnPropertyDescriptor(proto, prop)) === undefined) proto = Object.getPrototypeOf(proto) as object | null;
  const c = { what, n: 0 };
  const desc = d!;
  Object.defineProperty(obj, prop, {
    configurable: true,
    get(this: object) { return desc.get!.call(this); },
    set(this: object, v: unknown) { c.n++; desc.set!.call(this, v); },
  });
  return c;
}

/** Drawn display objects under a piece (its meshes; the piece's own
 *  container is counted separately). */
function drawables(c: Container): number {
  let n = 0;
  for (const ch of c.children) n += 1 + drawables(ch);
  return n;
}

describe('sub-capital wrecks: the quiet look (slice 4)', () => {
  for (const kind of ['fighter', 'gunship', 'missile-frigate']) {
    it(`${kind}: no burst, no blasts, no ripples, no front; a simple core glow gone by glowSeconds; ≤ 2 drawables per piece, then 1`, () => {
      const sinks: Sinks = { breaks: 0, blasts: 0, ripples: 0 };
      const ctx = makeCtx(stubArt(fighterArt()), sinks);
      const d = desc(kind, 31);
      const m = mirrorFor(d, DEATH_TICK + 3);
      const T0 = 10_000;
      ctx.fxNowMs = T0;
      updateSwarmSprites(m, ctx);
      const ps = pieces(ctx);
      expect(ps.length, 'a sub-cap breaks into 2-3 pieces').toBeGreaterThanOrEqual(2);
      expect(ps.length).toBeLessThanOrEqual(3);

      let glowingAtStart = 0;
      for (let f = 0; f <= 70; f++) {
        ctx.fxNowMs = T0 + f * 16;
        updateSwarmSprites(m, ctx);
        for (const p of pieces(ctx)) {
          expect(p.frontHeads(), 'no travelling white-hot head').toBe(0);
          expect(drawables(p), 'one art mesh + one short-lived glow').toBeLessThanOrEqual(2);
          if (f === 0 && p.glowAlpha() > 0) glowingAtStart++;
        }
      }
      expect(sinks.breaks, 'no break-up burst (WreckBreakFx)').toBe(0);
      expect(sinks.blasts, 'no kill blasts (wreckBlasts)').toBe(0);
      expect(sinks.ripples, 'no ripples').toBe(0);
      // Every cut lights at once (no front): every piece glows at first sight.
      expect(glowingAtStart, 'every piece glows at once').toBe(ps.length);

      ctx.fxNowMs = T0 + GLOW_MS + 1;
      updateSwarmSprites(m, ctx);
      for (const p of pieces(ctx)) {
        expect(p.glowAlpha(), 'dark by glowSeconds').toBe(0);
        expect(p.glowPositions(), 'the glow object is destroyed').toBeNull();
        expect(drawables(p), 'settled: one static art mesh').toBe(1);
        const art = p.children[0];
        expect(art).toBeInstanceOf(Mesh);
      }
    });
  }

  it('the simple glow is core only (no halo, no head quads) and fades monotonically', () => {
    const ctx = makeCtx(stubArt(fighterArt()), { breaks: 0, blasts: 0, ripples: 0 });
    const m = mirrorFor(desc('fighter', 31), DEATH_TICK);
    const T0 = 10_000;
    ctx.fxNowMs = T0;
    updateSwarmSprites(m, ctx);
    const p = pieces(ctx)[0]!;
    // One quad (4 vertices × xy) per cut segment.
    const pos = p.glowPositions()!;
    expect(pos.length % 8).toBe(0);
    expect(pos.length / 8, 'quads = cut segments (core only)').toBe(p.glowSegments());
    let prev = Infinity;
    for (let t = 0; t <= GLOW_MS; t += 50) {
      ctx.fxNowMs = T0 + t;
      updateSwarmSprites(m, ctx);
      const a = p.glowAlpha();
      expect(a).toBeLessThanOrEqual(prev + 1e-9);
      prev = a;
    }
  });

  it('the minimal effects tier gives no glow at all', () => {
    const ctx = makeCtx(stubArt(fighterArt()), { breaks: 0, blasts: 0, ripples: 0 }, 'minimal');
    const m = mirrorFor(desc('fighter', 31), DEATH_TICK);
    ctx.fxNowMs = 10_000;
    updateSwarmSprites(m, ctx);
    for (const p of pieces(ctx)) {
      expect(p.glowAlpha()).toBe(0);
      expect(p.glowPositions()).toBeNull();
      expect(drawables(p), 'just the art mesh').toBe(1);
    }
  });

  it('the minimal tier keeps the capital glow (capitals unchanged)', () => {
    const ctx = makeCtx(null, { breaks: 0, blasts: 0, ripples: 0 }, 'minimal');
    const m = mirrorFor({ ...desc('battleship', 11), killY: -400 }, DEATH_TICK);
    ctx.fxNowMs = 10_000;
    updateSwarmSprites(m, ctx);
    let glowing = 0;
    for (const p of pieces(ctx)) if (p.glowPositions() !== null) glowing++;
    expect(glowing).toBeGreaterThan(0);
  });

  it('a settled piece does no per-frame tint, texture or glow writes', () => {
    const ctx = makeCtx(stubArt(fighterArt()), { breaks: 0, blasts: 0, ripples: 0 });
    const m = mirrorFor(desc('fighter', 31), DEATH_TICK);
    const T0 = 10_000;
    ctx.fxNowMs = T0;
    updateSwarmSprites(m, ctx);
    ctx.fxNowMs = T0 + GLOW_MS + 100;
    updateSwarmSprites(m, ctx); // glow gone: settled
    const counters: Array<{ what: string; n: number }> = [];
    for (const p of pieces(ctx)) {
      counters.push(countSets(p, 'tint', 'piece tint'));
      for (const ch of p.children) {
        counters.push(countSets(ch, 'texture', 'mesh texture'));
        counters.push(countSets(ch, 'tint', 'mesh tint'));
      }
    }
    const writesBefore = pieces(ctx).map((p) => p.frameWrites());
    for (let f = 1; f <= 30; f++) {
      ctx.fxNowMs = T0 + GLOW_MS + 100 + f * 16;
      updateSwarmSprites(m, ctx);
    }
    for (const c of counters) expect(c.n, c.what).toBe(0);
    expect(pieces(ctx).map((p) => p.frameWrites()), 'no light-frame or glow work').toEqual(writesBefore);
    // A hit still flashes it (and the flash clears once).
    ctx.localHitTargets.add('swarm-100');
    updateSwarmSprites(m, ctx);
    expect(ctx.sprites.get('swarm-100')!.tint).not.toBe(0xffffff);
    ctx.localHitTargets.clear();
    updateSwarmSprites(m, ctx);
    expect(ctx.sprites.get('swarm-100')!.tint).toBe(0xffffff);
  });

  it('off-screen sub-cap pieces are culled (not drawn)', () => {
    const ctx = makeCtx(stubArt(fighterArt()), { breaks: 0, blasts: 0, ripples: 0 });
    const m = mirrorFor(desc('fighter', 31), DEATH_TICK);
    // A view far from the wreck (pixi space: minX, minY, maxX, maxY).
    ctx.viewBounds = new Float64Array([50_000, 50_000, 51_000, 51_000]);
    ctx.fxNowMs = 10_000;
    updateSwarmSprites(m, ctx);
    for (const p of pieces(ctx)) expect(p.visible).toBe(false);
    ctx.viewBounds = new Float64Array([-1_000, -1_000, 1_000, 1_000]);
    updateSwarmSprites(m, ctx);
    for (const p of pieces(ctx)) expect(p.visible).toBe(true);
  });

  it('the normal death explosion stays for a sub-cap (only a capital wreck replaces it)', () => {
    // capitalWrecks on, a non-capital dying sprite: the ship's own blast plays.
    expect(hullDeathBlastReplaced(true, false, 'fighter')).toBe(false);
    expect(hullDeathBlastReplaced(true, true, 'fighter'), 'even if flagged capital, the profile says no').toBe(false);
    expect(hullDeathBlastReplaced(true, true, 'battleship')).toBe(true);
    expect(SUB.hullDeathBlastReplaced).toBe(false);
  });

  it('debris stays off the radar and the far-zoom icons', () => {
    expect(radarCategoryForSwarm(4, false, 'fighter')).toBeNull();
    expect(radarCategoryForSwarm(4, true, 'fighter')).toBeNull();
    const m = mirrorFor(desc('fighter', 31), DEATH_TICK);
    (m as { ships: Map<string, unknown> }).ships = new Map();
    const sprites = new Map<string, Container>();
    for (const id of m.swarm!.keys()) sprites.set(`swarm-${id}`, new Container());
    const icons = new FarZoomIcons();
    icons.update(m, sprites, 0.001); // fully zoomed out: every ship would be an icon
    expect(icons.iconCount).toBe(0);
  });
});
