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
import { WreckArtState, WreckPieceSprite, deathBlastFor, hullDeathBlastReplaced } from './wreckArt.js';
import { radarCategoryForSwarm } from '../halo/arrowGraphics.js';
import { FarZoomIcons } from './FarZoomIcons.js';
import { DESTRUCTION_PROFILES } from '../../../shared-types/shipScale/destruction.js';
import { DAMAGE_FLASH_COLOR } from './spriteBuilders.js';
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
/** Is (x, y) inside the convex quad c = [x0, y0, … x3, y3] (either winding)? */
function inQuad(c: number[], x: number, y: number): boolean {
  let pos = false, neg = false;
  for (let i = 0; i < 4; i++) {
    const ax = c[i * 2]!, ay = c[i * 2 + 1]!, bx = c[((i + 1) % 4) * 2]!, by = c[((i + 1) % 4) * 2 + 1]!;
    const cr = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cr > 1e-9) pos = true;
    else if (cr < -1e-9) neg = true;
  }
  return !(pos && neg);
}

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
    // A hit still flashes it (on the art only) and the flash clears once,
    // back to the art's normal tint.
    const hitP = ctx.sprites.get('swarm-100') as WreckPieceSprite;
    ctx.localHitTargets.add('swarm-100');
    updateSwarmSprites(m, ctx);
    for (const t of artTints(hitP)) expect(t).toBe(DAMAGE_FLASH_COLOR);
    ctx.localHitTargets.clear();
    updateSwarmSprites(m, ctx);
    for (const t of artTints(hitP)) expect(t).toBe(0xffffff);
    expect(hitP.tint, 'the piece container stays untinted').toBe(0xffffff);
  });

  /** The colour a node is drawn with: its own tint times every ancestor's
   *  (Pixi v8 multiplies a container's tint into its children). */
  const chainTint = (n: Container): number => {
    let r = 255, g = 255, b = 255;
    for (let c: Container | null = n; c !== null; c = c.parent) {
      const t = c.tint as number;
      r = (r * ((t >> 16) & 255)) / 255; g = (g * ((t >> 8) & 255)) / 255; b = (b * (t & 255)) / 255;
    }
    return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  };

  /**
   * Round-2 review: "in the first frames only a thin orange line shows on one
   * edge; then the pieces look bright lilac with no warm edge". The glow is
   * drawn ON TOP of the dark art, in its own warm colour (nothing tints it: not
   * the art, not a hit flash), on every cut edge, and wide enough to read at
   * fleet-fight zoom (a few px at 0.45×).
   */
  it('the glow is drawn over the art, untinted (warm orange whatever the ship or a hit), on every cut, wide enough to see', () => {
    for (const kind of ['fighter', 'robot-square', 'robot-hexagon', 'gunship']) {
      const ctx = makeCtx(stubArt(fighterArt()), { breaks: 0, blasts: 0, ripples: 0 });
      const m = mirrorFor(desc(kind, 31), DEATH_TICK);
      let hullR = 0;
      for (const g of rebuildWreckPieces(desc(kind, 31))) hullR = Math.max(hullR, Math.hypot(g.cx, g.cy) + g.radius);
      const T0 = 10_000;
      ctx.fxNowMs = T0;
      updateSwarmSprites(m, ctx);
      for (const id of m.swarm!.keys()) ctx.localHitTargets.add(`swarm-${id}`); // under fire
      // From the first frame on (v5 film: a filled bar for ~0.2 s, then a line).
      for (const tMs of [0, 100, 200, 0.25 * GLOW_MS]) {
      ctx.fxNowMs = T0 + tMs;
      updateSwarmSprites(m, ctx);
      for (const p of pieces(ctx)) {
        const glow = p.children.find((c) => c instanceof Mesh && (c as Mesh).texture === p.glowTexture());
        expect(glow, `${kind}: a glow`).toBeDefined();
        const gi = p.children.indexOf(glow!);
        for (const c of p.children) if (c !== glow) expect(p.children.indexOf(c), `${kind}: the glow draws after the art`).toBeLessThan(gi);
        expect(chainTint(glow!), `${kind}: nothing tints the glow`).toBe(0xffffff);
        expect(glow!.blendMode === 'normal' || glow!.blendMode === 'add' || glow!.blendMode === 'inherit').toBe(true);
        // Its texel at this moment: warm orange (the curve), so the drawn colour is.
        const c = p.glowColor();
        expect((c >> 16) & 255, kind).toBeGreaterThan(((c >> 8) & 255) * 1.4);
        expect(((c >> 8) & 255), kind).toBeGreaterThanOrEqual(c & 255);
        // Every cut segment has a quad. The band reads as a LINE along the
        // cut: still >= 2 px at the fleet-fight zoom (0.45), but no wider than
        // ~0.15 x the wreck radius. Round-3 film: at 0.4 x radius it was an
        // opaque orange crescent covering much of each piece.
        const pos = p.glowPositions()!;
        expect(pos.length / 8).toBe(p.glowSegments());
        let widest = 0;
        for (let q = 0; q < pos.length; q += 8) widest = Math.max(widest, Math.hypot(pos[q]! - pos[q + 6]!, pos[q + 1]! - pos[q + 7]!));
        expect(widest * 0.45, `${kind} @${tMs} ms: glow width on screen (px)`).toBeGreaterThanOrEqual(2);
        expect(widest, `${kind} @${tMs} ms: glow band vs wreck radius ${hullR.toFixed(1)}`).toBeLessThanOrEqual(0.15 * hullR);
      }
      }
    }
  });

  /**
   * Owner's v5 film review (2026-11-13): the cut glow showed as a filled
   * 3–4 px bar for its first ~0.2 s, then thinned to a line. Each piece drew
   * its band INSIDE its own outline, so while the pieces still touched the
   * two bands lay side by side across the cut: one stroke twice as wide,
   * which split into two thin lines as they parted. The stroke across a cut
   * must be one band wide from the first frame (the pieces at rest here, as
   * at the break).
   */
  it('the cut glow is one thin line from the first frame: the bands either side of a cut overlap, not abut', () => {
    for (const kind of ['fighter', 'robot-square', 'gunship', 'missile-frigate']) {
      const ctx = makeCtx(stubArt(fighterArt()), { breaks: 0, blasts: 0, ripples: 0 });
      const m = mirrorFor(desc(kind, 31), DEATH_TICK);
      const T0 = 10_000;
      for (const tMs of [0, 100, 200]) {
        ctx.fxNowMs = T0 + tMs;
        updateSwarmSprites(m, ctx);
        // Every glow quad in world (Pixi) space: piece position + local corners.
        const quads: number[][] = [];
        let widest = 0;
        for (const p of pieces(ctx)) {
          const pos = p.glowPositions();
          if (pos === null) continue;
          for (let q = 0; q < pos.length; q += 8) {
            const c: number[] = [];
            for (let v = 0; v < 4; v++) c.push(p.x + pos[q + v * 2]!, p.y + pos[q + v * 2 + 1]!);
            quads.push(c);
            widest = Math.max(widest, Math.hypot(pos[q]! - pos[q + 6]!, pos[q + 1]! - pos[q + 7]!));
          }
        }
        expect(quads.length, kind).toBeGreaterThan(0);
        // Across the middle of each quad, along its own normal: how thick is
        // the glow from every piece together?
        let thickest = 0;
        for (const c of quads) {
          const w = Math.hypot(c[0]! - c[6]!, c[1]! - c[7]!);
          if (w < 1e-6) continue;
          const nx = (c[0]! - c[6]!) / w, ny = (c[1]! - c[7]!) / w;
          const mx = (c[0]! + c[2]! + c[4]! + c[6]!) / 4, my = (c[1]! + c[3]! + c[5]! + c[7]!) / 4;
          const step = widest / 40;
          let covered = 0;
          for (let t = -3 * widest; t <= 3 * widest; t += step) {
            const x = mx + nx * t, y = my + ny * t;
            if (quads.some((o) => inQuad(o, x, y))) covered++;
          }
          thickest = Math.max(thickest, covered * step);
        }
        expect(thickest, `${kind} @${tMs} ms: glow across a cut vs one band ${widest.toFixed(2)} u`)
          .toBeLessThanOrEqual(widest * 1.25);
      }
    }
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

  /** Every art mesh's tint under a piece (not the glow). */
  const artTints = (p: WreckPieceSprite): number[] => p.children
    .filter((c) => c instanceof Mesh && c.texture !== p.glowTexture())
    .map((c) => (c as Mesh).tint as number);

  /**
   * Owner 2026-11-13, after the v4 debris film: "The darkened scrap just
   * doesn't look right, what's the logic? Why would it darken when destroyed?
   * It should just be broken, same brightness?" Sub-cap pieces keep the
   * ship's normal art brightness and colour (untinted), during the glow and
   * after it; the thin glow on the cuts is the only change.
   */
  it('sub-cap pieces keep the ship\'s normal brightness: no dead tint, during or after the glow', () => {
    expect(SUB.deadTint, 'no dead tint on the profile').toBeNull();
    const ctx = makeCtx(stubArt(fighterArt()), { breaks: 0, blasts: 0, ripples: 0 });
    const m = mirrorFor(desc('robot-square', 31), DEATH_TICK);
    const T0 = 10_000;
    ctx.fxNowMs = T0;
    updateSwarmSprites(m, ctx);
    for (const p of pieces(ctx)) for (const t of artTints(p)) expect(t, 'normal while it glows').toBe(0xffffff);
    ctx.fxNowMs = T0 + GLOW_MS + 50;
    updateSwarmSprites(m, ctx);
    for (const p of pieces(ctx)) {
      const ts = artTints(p);
      expect(ts.length, 'still showing the art').toBeGreaterThan(0);
      for (const t of ts) expect(t, 'normal after the glow').toBe(0xffffff);
    }
  });

  it('a wreck with no glow (minimal tier) keeps its normal brightness from the start', () => {
    const ctx = makeCtx(stubArt(fighterArt()), { breaks: 0, blasts: 0, ripples: 0 }, 'minimal');
    const m = mirrorFor(desc('robot-square', 31), DEATH_TICK);
    ctx.fxNowMs = 10_000;
    updateSwarmSprites(m, ctx);
    for (const p of pieces(ctx)) for (const t of artTints(p)) expect(t).toBe(0xffffff);
  });

  /**
   * Hostile review 2026-11-13: "the glow lasted only ~0.4-0.6 s (the intent
   * is ~1 s), and its colour varies by ship type (orange on robots, magenta
   * or white on drones)". One consistent warm orange → dark fade over
   * `glowSeconds`, the same for every sub-cap kind.
   */
  it('the simple glow is a warm orange fade that lasts glowSeconds, the same for every kind', () => {
    const samples: Array<{ kind: string; t: number; a: number; c: number }> = [];
    for (const kind of ['fighter', 'robot-square', 'gunship']) {
      const ctx = makeCtx(stubArt(fighterArt()), { breaks: 0, blasts: 0, ripples: 0 });
      const m = mirrorFor(desc(kind, 31), DEATH_TICK);
      const T0 = 10_000;
      for (const f of [0, 0.25, 0.5, 0.75, 0.9]) {
        ctx.fxNowMs = T0 + f * GLOW_MS;
        updateSwarmSprites(m, ctx);
        const p = pieces(ctx)[0]!;
        samples.push({ kind, t: f, a: p.glowAlpha(), c: p.glowColor() });
      }
    }
    for (const s of samples) {
      const r = (s.c >> 16) & 255, g = (s.c >> 8) & 255, b = s.c & 255;
      const tag = `${s.kind} at ${s.t} of glowSeconds`;
      expect(r, `${tag}: warm (red over green)`).toBeGreaterThan(g * 1.4);
      expect(g, `${tag}: orange, not magenta (green over blue)`).toBeGreaterThanOrEqual(b);
      expect(g, `${tag}: never white-hot`).toBeLessThan(200);
      if (s.t <= 0.5) expect(s.a, `${tag}: glowing strongly`).toBeGreaterThanOrEqual(0.75);
    }
    // Still clearly visible three-quarters of the way through (~1 s total).
    for (const s of samples.filter((x) => x.t === 0.75)) expect(s.a, s.kind).toBeGreaterThanOrEqual(0.3);
    // The same curve on every kind.
    for (const f of [0, 0.25, 0.5, 0.75, 0.9]) {
      const at = samples.filter((s) => s.t === f);
      for (const s of at) {
        expect(s.c).toBe(at[0]!.c);
        expect(s.a).toBeCloseTo(at[0]!.a, 9);
      }
    }
  });

  /** Round-3 review 2026-11-13: "no red stage". The glow goes orange, then
   *  clearly red mid-fade (still well visible), then dark, over the 1 s. */
  it('the simple glow goes orange -> red -> dark over glowSeconds', () => {
    expect(SUB.glowSeconds).toBe(1);
    const ctx = makeCtx(stubArt(fighterArt()), { breaks: 0, blasts: 0, ripples: 0 });
    const m = mirrorFor(desc('robot-square', 31), DEATH_TICK);
    const T0 = 10_000;
    const at = (f: number): { r: number; g: number; a: number } => {
      ctx.fxNowMs = T0 + f * GLOW_MS;
      updateSwarmSprites(m, ctx);
      const p = pieces(ctx)[0]!;
      const c = p.glowColor();
      return { r: (c >> 16) & 255, g: (c >> 8) & 255, a: p.glowAlpha() };
    };
    at(0); // first sight starts the glow's clock
    const orange = at(0.2);
    expect(orange.g / orange.r, 'orange early (green well up)').toBeGreaterThanOrEqual(0.4);
    const red = at(0.6);
    expect(red.r, 'red mid-fade: bright red channel').toBeGreaterThanOrEqual(0xb0);
    expect(red.g / red.r, 'red mid-fade: little green (not orange)').toBeLessThanOrEqual(0.25);
    expect(red.a, 'red stage still clearly visible').toBeGreaterThanOrEqual(0.5);
    const dark = at(0.95);
    expect(dark.r, 'dark at the end').toBeLessThan(0x80);
  });

  /** Owner decision 2026-11-13: "Shrink it": a sub-cap's death explosion
   *  about half the size with shorter smoke, while the room breaks
   *  sub-caps into wrecks; unchanged when off; capitals unchanged. */
  it('the death blast is shrunk for sub-caps when subcapWrecks is on, unchanged otherwise', () => {
    const out = { scale: 0, linger: 0 };
    deathBlastFor(true, false, 'robot-square', out);
    expect(out).toEqual({ scale: SUB.deathBlastScale, linger: SUB.deathBlastLinger });
    expect(out.scale).toBeCloseTo(0.5, 5);
    expect(out.linger).toBeCloseTo(0.5, 5);
    deathBlastFor(true, false, 'fighter', out);
    expect(out.scale).toBeCloseTo(0.5, 5);
    for (const [sub, cap, kind] of [
      [false, false, 'fighter'], [undefined, true, 'fighter'], [true, true, 'battleship'], [true, false, 'battleship'],
      [true, false, 'cargo-pod'], [true, false, null], [true, false, 'no-such-kind'],
    ] as const) {
      deathBlastFor(sub, cap, kind, out);
      expect(out, `${String(sub)} ${String(cap)} ${String(kind)}`).toEqual({ scale: 1, linger: 1 });
    }
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
