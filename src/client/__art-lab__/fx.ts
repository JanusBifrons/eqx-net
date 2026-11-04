/**
 * FX lab runtime (plan iridescent-seeking-rainbow v2).
 *
 * Renders one deterministic scene with one arm:
 *  - `fx=today` — today's effects, rebuilt from the game's own builders and
 *    pools (BeamSpritePool, the bolt / missile / explosion Graphics, the
 *    shield ring, the LOD starfield). Animation curves are approximations of
 *    the game's updaters; no filters (the game adds a glow filter on high).
 *  - `fx=new`   — the candidates: baked effect textures drawn as batched
 *    sprites, the shield-hit flipbook (`shield=sprite`) or shader
 *    (`shield=shader`), and the new backdrop (nebula `neb=…`, baked star
 *    tiles, sun, planet, dust) plus environment props.
 *
 * Ships, structures and asteroids are Machined in both arms, so only the
 * effects and the environment differ. A frame is a pure function of `t`;
 * nothing allocates per frame.
 *
 * Dev-only page: /__art-lab__/fx.html?fx=today|new&scene=…&shield=sprite|shader&neb=emission|reflection|dark|none
 */
import {
  Application, type BLEND_MODES, Container, Geometry, GlProgram, Graphics, Mesh, MeshRope, Point, Rectangle, Shader, Sprite,
  Texture, TilingSprite, UniformGroup, CanvasSource,
} from 'pixi.js';
import { ArtCache, SUN_STEPS, type ShipArt } from './assets.js';
import { buildFxScene, FX_SCENE_IDS, type BoomSize, type FxFence, type FxScene, type FxSceneId, type FxShot } from './fxScenes.js';
import type { Cam, Pose } from './scenes.js';
import { seedVariant, runBake, type BakeJob } from '../render/art/bake.js';
import type { Frame } from '../render/art/shade.js';
import {
  beamFlowTex, dustTileTex, fireballFlipbook, galaxyTex, glowTex, imgGpuBytes, nebulaTex, planetTex, ringTex,
  fenceContactTex, fenceRippleFlipbook, fenceStripFlipbook, h01, shieldContactTex, shieldDomeTex, shieldHitFlipbook, smokeTex, sparkTex, spikeStarTex, starTileTex, streakTex, sunTex, trailTex, wispTex,
  type Flipbook, type Img, type NebulaKind,
} from '../render/art/fx/fxTextures.js';
import { backdropXf, emberTint, envelope, flipFrame, lerpRgb, zoomWindow, SHIELD_HITS, SHIELD_CONTACTS, ShieldContacts, type TileXf } from '../render/art/fx/fxMath.js';
import { SHIELD_FRAGMENT, SHIELD_QUAD_INDEX, SHIELD_QUAD_POS, SHIELD_QUAD_UV, SHIELD_VERTEX } from '../render/art/fx/shieldShader.js';
import { BeamSpritePool, type BeamView } from '../render/BeamSpritePool.js';
import { buildExplosionGfx, buildLaserBoltGfx, buildMissileExplosionGfx, buildMissileGfx, buildProjectileGfx } from '../render/pixi/spriteBuilders.js';
import { StarfieldBackground } from '../render/StarfieldBackground.js';
import { shipScrapGroups } from '../../core/geometry/shipScrapGroups.js';
import { SHIP_KINDS_LIST } from '../../shared-types/shipKinds.js';
import { cometSegment, shieldWallVisualParams, type ShieldWallVisual } from '../render/pixi/connectorVisual.js';

const qs = new URLSearchParams(location.search);
const ARM: 'today' | 'new' = qs.get('fx') === 'today' ? 'today' : 'new';
const NEW = ARM === 'new';
const SCENE = ((FX_SCENE_IDS as readonly string[]).includes(qs.get('scene') ?? '') ? qs.get('scene') : 'weapons') as FxSceneId;
const SHIELD_MODE: 'sprite' | 'shader' = qs.get('shield') === 'shader' ? 'shader' : 'sprite';
const NEB = (['emission', 'reflection', 'dark', 'none'].includes(qs.get('neb') ?? '') ? qs.get('neb') : 'emission') as NebulaKind | 'none';
const ZOOM = qs.has('zoom') ? Number(qs.get('zoom')) : undefined;
const N = qs.has('n') ? Number(qs.get('n')) : 12;
const TWINKLE = qs.get('twinkle') !== '0';
/** Beams on shields: held contacts (default) or round 1's repeated hits (`contact=0`). */
const CONTACT = qs.get('contact') !== '0';

// ------------------------------------------------------------------ textures

const bakeMs: Record<string, number> = {};
const fxImgs: Img[] = [];

function toTexture(i: Img, repeat = false, mip = false): Texture {
  const c = document.createElement('canvas');
  c.width = i.w; c.height = i.h;
  c.getContext('2d')!.putImageData(new ImageData(i.data as Uint8ClampedArray<ArrayBuffer>, i.w, i.h), 0, 0);
  const source = new CanvasSource({
    resource: c, scaleMode: 'linear', autoGenerateMipmaps: mip,
    addressMode: repeat ? 'repeat' : 'clamp-to-edge',
  });
  return new Texture({ source });
}

/** Generate + time + upload one effects texture. */
function fxTex(name: string, make: () => Img, repeat = false, mip = false): Texture {
  const t0 = performance.now();
  const i = make();
  bakeMs[name] = Math.round((performance.now() - t0) * 10) / 10;
  fxImgs.push(i);
  return toTexture(i, repeat, mip);
}

function flipFrames(name: string, make: () => Flipbook): Texture[] {
  const t0 = performance.now();
  const fb = make();
  bakeMs[name] = Math.round((performance.now() - t0) * 10) / 10;
  fxImgs.push(fb.sheet);
  const base = toTexture(fb.sheet);
  const out: Texture[] = [];
  for (let f = 0; f < fb.frames; f++) {
    const rows = Math.ceil(fb.frames / fb.cols), ch = fb.sheet.h / rows;
    out.push(new Texture({ source: base.source, frame: new Rectangle((f % fb.cols) * fb.cell + 1, Math.floor(f / fb.cols) * ch + 1, fb.cell - 2, ch - 2) }));
  }
  return out;
}

function frameTexture(f: Frame): Texture {
  return toTexture({ w: f.w, h: f.h, data: f.data });
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const host = document.getElementById('host')!;
  const W = Number(qs.get('w') ?? window.innerWidth) | 0;
  const H = Number(qs.get('h') ?? window.innerHeight) | 0;
  const app = new Application();
  await app.init({
    width: W, height: H, background: 0x03050b, antialias: true,
    resolution: qs.get('dpr') === '1' ? window.devicePixelRatio || 1 : 1, autoDensity: qs.get('dpr') === '1',
    autoStart: false, preference: 'webgl', preserveDrawingBuffer: true,
  });
  host.appendChild(app.canvas);

  const scene: FxScene = buildFxScene(SCENE, ZOOM, N);
  const cache = new ArtCache();
  const rig = cache.rig;
  const t0Bake = performance.now();
  {
    const jobs: BakeJob[] = [];
    for (const st of scene.structs) jobs.push({ type: 'struct', id: st.id, seed: seedVariant(st.seed) });
    for (const sh of scene.ships) jobs.push({ type: 'ship', id: sh.id, paint: sh.paint });
    await cache.prebake(jobs, Number(qs.get('workers') ?? 4), qs.get('persist') !== '0');
  }
  const artBakeMs = performance.now() - t0Bake;

  // Effects textures (new arm only).
  const t0Fx = performance.now();
  const T = NEW ? {
    glow: fxTex('glow', () => glowTex(64)),
    streak: fxTex('streak', () => streakTex(128, 32)),
    flow: fxTex('beamFlow', () => beamFlowTex(256, 32), true),
    ring: fxTex('ring', () => ringTex(128)),
    spark: fxTex('spark', () => sparkTex(32, 8)),
    smoke: fxTex('smoke', () => smokeTex(64)),
    trail: fxTex('trail', () => trailTex(128, 16)),
    dome: fxTex('shieldDome', () => shieldDomeTex(256)),
    contact: fxTex('shieldContact', () => shieldContactTex(192)),
    fenceStrip: flipFrames('fenceStrip', () => fenceStripFlipbook(8, 128, 48)),
    fenceRipple: flipFrames('fenceRipple', () => fenceRippleFlipbook(8, 128, 48)),
    fenceContact: fxTex('fenceContact', () => fenceContactTex(128, 48)),
    spike: fxTex('spikeStar', () => spikeStarTex(64)),
    galaxy: fxTex('galaxy', () => galaxyTex(64)),
    sun: fxTex('sun', () => sunTex(256)),
    wisp: fxTex('wisp', () => wispTex(128)),
    dust: fxTex('dust', () => dustTileTex(512), true),
    starFar: fxTex('starsFar', () => starTileTex(512, 950, 11, 1.3), true, true),
    starMid: fxTex('starsMid', () => starTileTex(512, 260, 23, 1.0), true, true),
    starNear: fxTex('starsNear', () => starTileTex(512, 70, 37, 0.85), true, true),
    planet: scene.planet ? fxTex('planet', () => planetTex(256, rig.sunAz)) : Texture.EMPTY,
    nebula: NEB !== 'none' ? fxTex(`nebula-${NEB}`, () => nebulaTex(NEB, 512, 21), true) : Texture.EMPTY,
    dark: NEB === 'emission' ? fxTex('nebula-dark', () => nebulaTex('dark', 512, 57), true) : Texture.EMPTY,
    fire: flipFrames('fireball', () => fireballFlipbook(16, 128)),
    hit: flipFrames('shieldHit', () => shieldHitFlipbook(12, 192)),
  } : null;
  const fxBakeMs = performance.now() - t0Fx;

  // ---- layers
  const sky = new Container();
  const world = new Container();
  const fore = new Container();
  const today = !NEW;
  let starfield: StarfieldBackground | null = null;
  if (today) { starfield = new StarfieldBackground(); starfield.attach(app); }
  app.stage.addChild(sky, world, fore);
  const L = (blend: BLEND_MODES = 'normal'): Container => { const c = new Container(); c.blendMode = blend; world.addChild(c); return c; };
  const wispL = L('add'), rockL = L(), wreckL = L(), structL = L(), smokeL = L(), shipL = L(), glowL = L('add'), fxL = L('add'), shieldL = L('add');
  const todayL = L();
  fore.blendMode = 'add';

  const sprite = (tex: Texture, layer: Container, tint = 0xffffff, ax = 0.5, ay = 0.5): Sprite => {
    const s = new Sprite(tex); s.anchor.set(ax, ay); s.tint = tint; s.alpha = 0; layer.addChild(s); return s;
  };

  // ---- backdrop (new)
  interface Tile { s: TilingSprite; parallax: number; zoomPow: number; texScale: number; win?: [number, number, number, number]; alpha: number }
  const tiles: Tile[] = [];
  const tileLayer = (tex: Texture, parallax: number, zoomPow: number, texScale: number, alpha: number, blend: BLEND_MODES,
    parent: Container, win?: [number, number, number, number]): Tile => {
    const s = new TilingSprite({ texture: tex, width: W, height: H });
    s.blendMode = blend; s.alpha = alpha;
    parent.addChild(s);
    const t: Tile = { s, parallax, zoomPow, texScale, win, alpha };
    tiles.push(t);
    return t;
  };
  interface SkySprite { s: Sprite; lx: number; ly: number; parallax: number; zoomPow: number; size: number; alpha: number; tw: number }
  const skySprites: SkySprite[] = [];
  if (T) {
    if (NEB !== 'none') tileLayer(T.nebula, 0.012, 0.08, 2.6, NEB === 'dark' ? 0.85 : NEB === 'emission' ? 0.48 : 0.72, NEB === 'dark' ? 'normal' : 'add', sky);
    tileLayer(T.starFar, 0.02, 0.1, 1, 0.95, 'add', sky);
    const gal = (lx: number, ly: number, size: number): void => {
      skySprites.push({ s: sprite(T.galaxy, sky, 0xffffff), lx, ly, parallax: 0.015, zoomPow: 0.06, size, alpha: 0.5, tw: 0 });
    };
    gal(-260, -140, 46); gal(330, 210, 30); gal(80, -300, 22);
    // The sun sits far out along the light direction, so it agrees with the hulls.
    const sunD = Math.max(W, H) * 0.55;
    skySprites.push({ s: sprite(T.sun, sky, 0xfff0d8), lx: Math.cos(rig.sunAz) * sunD, ly: Math.sin(rig.sunAz) * sunD, parallax: 0.004, zoomPow: 0.03, size: 520, alpha: 0.95, tw: 0 });
    tileLayer(T.starMid, 0.045, 0.22, 1, 0.9, 'add', sky);
    if (NEB === 'emission') tileLayer(T.dark, 0.03, 0.15, 2.2, 0.55, 'normal', sky);
    for (let i = 0; i < 7; i++) {
      skySprites.push({ s: sprite(T.spike, sky, i % 3 ? 0xdfe8ff : 0xffe2c0), lx: ((i * 0.37) % 1 - 0.5) * W * 1.6, ly: ((i * 0.61) % 1 - 0.5) * H * 1.6,
        parallax: 0.05, zoomPow: 0.2, size: 26 + (i % 3) * 10, alpha: 0.9, tw: TWINKLE ? 1 : 0 });
    }
    tileLayer(T.starNear, 0.085, 0.35, 1, 0.9, 'add', sky, [0.22, 0.45, Infinity, Infinity]);
    // The planet is nearer than the stars, so it hides them.
    if (scene.planet) {
      const p = sprite(T.planet, sky); p.blendMode = 'normal';
      skySprites.push({ s: p, lx: -W * 0.32, ly: H * 0.26, parallax: 0.03, zoomPow: 0.1, size: 210, alpha: 1, tw: 0 });
    }
    // Dust streams past in front of the world (parallax above 1).
    tileLayer(T.dust, 1.25, 1.0, 1, 0.3, 'add', fore, [0.3, 0.6, Infinity, Infinity]);
  }

  // ---- environment: rocks, wisps, wreck
  interface RockV { x: number; y: number; glints: Sprite[]; gxy: Float32Array; ph: number }
  const rocks: RockV[] = [];
  for (const r of scene.rocks) {
    const v: RockV = { x: r.x, y: r.y, glints: [], gxy: new Float32Array(4), ph: r.id * 0.37 };
    const b = runBake({ type: 'rock', id: 'rock', entityId: r.id, radius: r.r, resource: r.resource, rot: 0 }, rig);
    const s = new Sprite(frameTexture(b.frames[0]!)); s.anchor.set(0.5); s.scale.set(1 / b.density); s.position.set(r.x, r.y);
    rockL.addChild(s);
    if (T && r.resource) {
      for (let k = 0; k < 2; k++) {
        v.glints.push(sprite(T.spike, glowL, r.resource === 'ice' ? 0xcfeaff : 0xe0c0ff));
        const a = r.id * 1.7 + k * 2.4;
        v.gxy[k * 2] = r.x + Math.cos(a) * r.r * 0.55; v.gxy[k * 2 + 1] = r.y + Math.sin(a) * r.r * 0.55;
      }
    }
    rocks.push(v);
  }
  const wisps: Array<{ s: Sprite; rot: number }> = [];
  if (T) for (const w of scene.wisps) {
    const s = sprite(T.wisp, wispL, w.tint); s.position.set(w.x, w.y); s.scale.set(w.size / 128); s.rotation = w.rot;
    wisps.push({ s, rot: w.rot });
  }
  // Wreck: the Machined scrap of a composite hull, drifting apart, lights flickering.
  interface WreckPart { s: Sprite; frames: Texture[]; x: number; y: number; dx: number; dy: number; rot: number; spin: number }
  const wreckParts: WreckPart[] = [];
  const wreckSparks: Array<{ s: Sprite; x: number; y: number; ph: number }> = [];
  const scrapFor = (kind: string): Array<{ frames: Texture[]; density: number; cx: number; cy: number }> => {
    const groups = shipScrapGroups(kind);
    const scale = (SHIP_KINDS_LIST.find((k) => k.id === kind)?.shape as { scale?: number } | undefined)?.scale ?? 1;
    return groups.map((g, c) => {
      const b = runBake({ type: 'scrap', id: kind, component: c }, rig);
      return { frames: b.frames.map(frameTexture), density: b.density, cx: g.centroid[0] * scale, cy: -g.centroid[1] * scale };
    });
  };
  if (scene.wreck) {
    const wk = scene.wreck;
    for (const [i, p] of scrapFor(wk.kind).entries()) {
      const s = new Sprite(p.frames[0]!); s.anchor.set(0.5); s.scale.set(wk.scale / p.density); s.tint = NEW ? 0x9aa2b0 : 0xffffff;
      wreckL.addChild(s);
      const d = Math.hypot(p.cx, p.cy) || 1;
      wreckParts.push({ s, frames: p.frames, x: wk.x + p.cx * wk.scale * 1.4, y: wk.y + p.cy * wk.scale * 1.4,
        dx: (p.cx / d) * 3, dy: (p.cy / d) * 3, rot: i * 0.4, spin: ((i % 3) - 1) * 0.03 });
    }
    if (T) for (let k = 0; k < 4; k++) {
      const p = wreckParts[k % wreckParts.length]!;
      wreckSparks.push({ s: sprite(T.glow, glowL, k % 2 ? 0x8fd8ff : 0xffc070), x: p.x + (k - 1.5) * 9, y: p.y + (k % 2) * 7, ph: k * 1.9 });
    }
  }

  // ---- structures
  scene.structs.forEach((st) => {
    const art = cache.machinedStruct(st.id, st.seed);
    const s = new Sprite(art.tex); s.anchor.set(0.5); s.scale.set(1 / art.density); s.position.set(st.x, st.y);
    structL.addChild(s);
  });

  // ---- ships (Machined: cross-fade the two nearest baked sun frames)
  interface ShipV { pose: Pose; a: Sprite; b: Sprite; art: ShipArt; nozzles: Sprite[]; r: number; deadAt: number; phase: number }
  const ships: ShipV[] = scene.ships.map((e, i) => {
    const art = cache.machinedShip(e.id, e.paint);
    const a = new Sprite(art.frames[0]!), b = new Sprite(art.frames[0]!);
    a.anchor.set(0.5); b.anchor.set(0.5); a.scale.set(1 / art.density); b.scale.set(1 / art.density);
    shipL.addChild(a, b);
    const nozzles: Sprite[] = [];
    if (T) for (let k = 0; k < art.nozzles.length; k++) nozzles.push(sprite(T.glow, glowL, 0xffa24a));
    return { pose: { x: 0, y: 0, rot: 0, thrust: 0 }, a, b, art, nozzles, r: (Math.max(art.w, art.h) / art.density) * 0.32, deadAt: Infinity, phase: i * 0.37 };
  });
  for (const bm of scene.booms) if (bm.ship !== undefined) ships[bm.ship]!.deadAt = bm.t0;
  const shieldOf = new Int32Array(ships.length).fill(-1);
  scene.shields.forEach((s, i) => { shieldOf[s.ship] = i; });

  const tmpA: Pose = { x: 0, y: 0, rot: 0, thrust: 0 };
  const tmpB: Pose = { x: 0, y: 0, rot: 0, thrust: 0 };
  const pt = { x: 0, y: 0 };
  const local = (p: Pose, lx: number, ly: number, out: { x: number; y: number }): void => {
    const c = Math.cos(p.rot), s = Math.sin(p.rot);
    out.x = p.x + lx * c - ly * s; out.y = p.y + lx * s + ly * c;
  };
  const shieldUp = (shipIdx: number, t: number): boolean => {
    const si = shieldOf[shipIdx]!;
    if (si < 0) return false;
    const b = scene.shields[si]!.breakAt;
    return b === undefined || t < b;
  };

  // ---- weapons
  interface Geo { mx: number; my: number; ix: number; iy: number; len: number; ang: number; ok: boolean; shielded: boolean }
  const geo = (sh: FxShot, t: number, g: Geo): Geo => {
    if (sh.wall !== undefined) return geoWall(sh, t, g);
    scene.ships[sh.from]!.pose(t, tmpA); scene.ships[sh.to]!.pose(t, tmpB);
    const tgt = ships[sh.to]!;
    g.ok = t < ships[sh.from]!.deadAt && t < tgt.deadAt;
    const dx = tmpB.x - tmpA.x, dy = tmpB.y - tmpA.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
    g.shielded = shieldUp(sh.to, t);
    const stand = g.shielded ? scene.shields[shieldOf[sh.to]!]!.radius * 0.97 : tgt.r * 0.7;
    g.mx = tmpA.x + ux * 12; g.my = tmpA.y + uy * 12;
    g.ix = tmpB.x - ux * stand; g.iy = tmpB.y - uy * stand;
    g.len = Math.hypot(g.ix - g.mx, g.iy - g.my); g.ang = Math.atan2(g.iy - g.my, g.ix - g.mx);
    return g;
  };
  const G: Geo = { mx: 0, my: 0, ix: 0, iy: 0, len: 0, ang: 0, ok: true, shielded: false };
  /** A shot at a fence: the impact point is on the wall (with a slow wander
   *  for beams), and it counts as a shield hit while the wall is up. */
  function geoWall(sh: FxShot, t: number, g: Geo): Geo {
    const fe = scene.fences![sh.wall!]!;
    scene.ships[sh.from]!.pose(t, tmpA);
    const wt = (sh.wallT ?? 0.5) + (sh.kind === 'beam' ? Math.sin(t * 0.9 + sh.from) * 0.025 : 0);
    tmpB.x = fe.ax + (fe.bx - fe.ax) * wt; tmpB.y = fe.ay + (fe.by - fe.ay) * wt;
    g.ok = t < ships[sh.from]!.deadAt;
    g.shielded = fenceUp(fe, t);
    const dx = tmpB.x - tmpA.x, dy = tmpB.y - tmpA.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
    g.mx = tmpA.x + ux * 12; g.my = tmpA.y + uy * 12;
    g.ix = tmpB.x; g.iy = tmpB.y;
    g.len = Math.hypot(g.ix - g.mx, g.iy - g.my); g.ang = Math.atan2(g.iy - g.my, g.ix - g.mx);
    return g;
  }
  function fenceUp(fe: FxFence, t: number): boolean {
    for (const [a, b] of fe.up) if (t >= a && t < b) return true;
    return false;
  }

  interface Impact { flare: Sprite; sparks: Sprite[]; puffs: Sprite[] }
  const SPARKS = 6;
  const mkImpact = (color: number, puffs = 0): Impact => ({
    flare: sprite(T!.glow, fxL, lerpRgb(color, 0xffffff, 0.5)),
    sparks: Array.from({ length: SPARKS }, () => sprite(T!.spark, fxL, 0xffffff, 1, 0.5)),
    puffs: Array.from({ length: puffs }, () => { const s = sprite(T!.smoke, smokeL, 0x8a8070); return s; }),
  });
  /** A hull hit: flare + sparks sprayed back toward the shooter. `k` is a
   *  0..1 phase within the spray cycle; `I` intensity. */
  const drawImpact = (im: Impact, g: Geo, I: number, k: number, size: number): void => {
    const on = !g.shielded && g.ok;
    // Every beam and bolt gets its own hot point, on the hull or on the shield;
    // sparks only fly off the hull.
    im.flare.position.set(g.ix, g.iy);
    im.flare.scale.set((size / 64) * (0.75 + 0.4 * I) * (g.shielded ? 0.8 : 1));
    im.flare.alpha = g.ok && (on || CONTACT) ? I : 0;
    for (let j = 0; j < SPARKS; j++) {
      const s = im.sparks[j]!;
      const ph = (k + j / SPARKS) % 1;
      const dir = g.ang + Math.PI + (((j * 0.618) % 1) - 0.5) * 2.0;
      const d = ph * (10 + ((j * 0.37) % 1) * 22) * (size / 26);
      s.position.set(g.ix + Math.cos(dir) * d, g.iy + Math.sin(dir) * d);
      s.rotation = dir;
      s.scale.set((10 + 8 * (1 - ph)) / 32 * (size / 26), 0.35);
      s.tint = emberTint(1 - ph);
      s.alpha = on ? I * (1 - ph) : 0;
    }
  };

  interface ShotV { sh: FxShot; draw: (t: number) => void }
  const shotViews: ShotV[] = [];

  // Recent hits on each shield (top-4 by recency), filled every frame.
  const hitAng = new Float32Array(scene.shields.length * SHIELD_HITS);
  const hitAge = new Float32Array(scene.shields.length * SHIELD_HITS);
  const hitPow = new Float32Array(scene.shields.length * SHIELD_HITS);
  const HIT_LIFE = 0.5;
  const contacts: ShieldContacts[] = scene.shields.map(() => new ShieldContacts());
  let lastT = -1;
  const pushHit = (si: number, ang: number, age: number, pow: number): void => {
    if (age < 0 || age >= HIT_LIFE) return;
    const o = si * SHIELD_HITS;
    // Insert keeping the youngest four.
    let worst = 0;
    for (let k = 1; k < SHIELD_HITS; k++) if (hitAge[o + k]! > hitAge[o + worst]!) worst = k;
    if (age >= hitAge[o + worst]!) return;
    hitAge[o + worst] = age; hitAng[o + worst] = ang; hitPow[o + worst] = pow;
  };

  for (const sh of scene.shots) {
    scene.ships[sh.from]!.pose(0, tmpA); scene.ships[sh.to]!.pose(0, tmpB);
    if (sh.wall !== undefined) geoWall(sh, 0, G);
    const dist0 = sh.wall !== undefined ? G.len : Math.hypot(tmpB.x - tmpA.x, tmpB.y - tmpA.y);
    const per = sh.period ?? 0.3, sp = sh.speed ?? 500;
    const flightMax = (dist0 * 1.35) / sp;
    if (sh.kind === 'beam') {
      if (NEW) {
        const halo = sprite(T!.streak, fxL, sh.color, 0, 0.5);
        const flow = new TilingSprite({ texture: T!.flow, width: 64, height: 32 });
        flow.anchor.set(0, 0.5); flow.tint = sh.color; flow.alpha = 0; fxL.addChild(flow);
        const core = sprite(T!.streak, fxL, 0xffffff, 0, 0.5);
        const muzzle = sprite(T!.glow, fxL, sh.color);
        const im = mkImpact(sh.color);
        const beamKey = scene.shots.indexOf(sh);
        shotViews.push({ sh, draw: (t) => {
          geo(sh, t, G);
          const on = t >= sh.t0 && t <= sh.t1 && G.ok;
          const ramp = on ? Math.min(1, (t - sh.t0) * 10, (sh.t1 - t) * 10) : 0;
          const fl = 0.88 + 0.12 * Math.sin(t * 57 + sh.from) * Math.sin(t * 23);
          halo.position.set(G.mx, G.my); halo.rotation = G.ang; halo.scale.set(G.len / 128, (22 * fl) / 32); halo.alpha = ramp * 0.7;
          flow.position.set(G.mx, G.my); flow.rotation = G.ang; flow.width = G.len; flow.scale.y = 9 / 32;
          flow.tilePosition.x = -t * 420; flow.alpha = ramp;
          core.position.set(G.mx, G.my); core.rotation = G.ang; core.scale.set(G.len / 128, 3 / 32); core.alpha = ramp;
          muzzle.position.set(G.mx, G.my); muzzle.scale.set(20 / 64 * fl); muzzle.alpha = ramp * 0.9;
          drawImpact(im, G, ramp * fl, (t * 2.6) % 1, 40);
          if (sh.wall !== undefined) {
            if (G.shielded && ramp > 0) fenceBeam(sh.wall, beamKey, sh.wallT ?? 0.5, t, sh);
          } else if (G.shielded && ramp > 0) {
            const si = shieldOf[sh.to]!;
            const ang = Math.atan2(tmpA.y - tmpB.y, tmpA.x - tmpB.x);
            if (CONTACT) {
              // A beam on a shield is one held contact, not a stream of hits.
              contacts[si]!.offer(beamKey, ang, 1);
            } else {
              // Round 1: a fresh hit every 0.2 s (reads as flicker).
              const since = (t - sh.t0) % 0.2;
              pushHit(si, ang, since, 0.5);
            }
          }
        } });
      } else {
        const pool = new BeamSpritePool({ tint: 0xffffff, width: 2, alpha: 1, taper: true });
        todayL.addChild(pool.container);
        const views: BeamView[] = [{ fromX: 0, fromY: 0, toX: 0, toY: 0, solidLen: 0 }];
        shotViews.push({ sh, draw: (t) => {
          geo(sh, t, G);
          const on = t >= sh.t0 && t <= sh.t1 && G.ok;
          const v = views[0]!;
          v.fromX = G.mx; v.fromY = -G.my; v.toX = G.ix; v.toY = -G.iy; // the pool takes game space (Y-up) v.solidLen = G.len;
          pool.setBeams(views, on ? 1 : 0);
        } });
      }
      continue;
    }
    // Projectiles.
    const nSlots = Math.ceil((flightMax + 0.7) / per) + 1;
    const missile = sh.kind === 'missile';
    const cannon = sh.kind === 'cannon';
    /** Missile path: a curve bowed to one side, alternating per launch. */
    const pathAt = (f: number, n: number, g: Geo, out: { x: number; y: number }): void => {
      if (!missile) { out.x = g.mx + (g.ix - g.mx) * f; out.y = g.my + (g.iy - g.my) * f; return; }
      const side = (n % 2 ? 1 : -1) * g.len * 0.32;
      const nx = -Math.sin(g.ang), ny = Math.cos(g.ang);
      const cx = (g.mx + g.ix) / 2 + nx * side, cy = (g.my + g.iy) / 2 + ny * side;
      const u = 1 - f;
      out.x = u * u * g.mx + 2 * u * f * cx + f * f * g.ix;
      out.y = u * u * g.my + 2 * u * f * cy + f * f * g.iy;
    };
    const flightOf = (g: Geo): number => (missile ? g.len * 1.12 : g.len) / sp;

    if (!NEW) {
      const heads: Graphics[] = [], booms: Graphics[] = [];
      for (let k = 0; k < nSlots; k++) {
        const h = missile ? buildMissileGfx() : cannon ? buildProjectileGfx(false) : buildLaserBoltGfx();
        h.visible = false; todayL.addChild(h); heads.push(h);
        if (missile) { const b = buildMissileExplosionGfx(); b.visible = false; todayL.addChild(b); booms.push(b); }
      }
      const dots: Graphics[] = [];
      for (let k = 0; k < 6; k++) { const d = new Graphics().circle(0, 0, 1.6).fill(sh.kind === 'missile' ? 0xffaa44 : 0xff8844); d.visible = false; todayL.addChild(d); dots.push(d); }
      shotViews.push({ sh, draw: (t) => {
        geo(sh, t, G);
        const flight = flightOf(G);
        const nNow = Math.floor((t - sh.t0) / per);
        for (let k = 0; k < nSlots; k++) {
          const n = nNow - k, h = heads[k]!;
          h.visible = false;
          if (booms[k]) booms[k]!.visible = false;
          const tf = sh.t0 + n * per;
          if (n < 0 || tf > sh.t1) continue;
          const age = t - tf;
          if (age >= 0 && age <= flight && G.ok) {
            const f = age / flight;
            pathAt(f, n, G, pt);
            pathAt(Math.min(1, f + 0.01), n, G, tmpPt);
            h.position.set(pt.x, pt.y); h.rotation = Math.atan2(tmpPt.y - pt.y, tmpPt.x - pt.x) + Math.PI / 2; h.visible = true;
          } else if (missile && age > flight && age < flight + 0.4) {
            const b = booms[k]!, a = age - flight;
            b.position.set(G.ix, G.iy); b.scale.set(0.6 + a * 2.5); b.alpha = 1 - a / 0.4; b.visible = true;
          }
        }
        // ImpactSparks: a few dots at the latest hit.
        const since = (((t - sh.t0 - flight) % per) + per) % per;
        const hitOn = t - sh.t0 > flight && G.ok && since < 0.32;
        for (let k = 0; k < dots.length; k++) {
          const d = dots[k]!;
          d.visible = hitOn && !missile;
          const dir = G.ang + Math.PI + (k / dots.length - 0.5) * 2.4;
          const r = since * 60;
          d.position.set(G.ix + Math.cos(dir) * r, G.iy + Math.sin(dir) * r); d.alpha = 1 - since / 0.32;
          if (G.shielded) d.tint = 0x88ddff; else d.tint = 0xffffff;
        }
        if (G.shielded && t - sh.t0 > flight) pulseToday(sh.to, since);
      } });
      continue;
    }

    // New projectiles.
    interface Slot {
      head: Sprite; core: Sprite; trail: Sprite[]; glow: Sprite;
      rope?: MeshRope; ropePts?: Point[]; hot?: MeshRope; hotPts?: Point[];
      fire?: Sprite; flash?: Sprite; embers?: Sprite[];
    }
    const slots: Slot[] = [];
    const ROPE = 22, HOT = 7;
    for (let k = 0; k < nSlots; k++) {
      const s: Slot = {
        head: sprite(T!.streak, fxL, sh.color), core: sprite(T!.streak, fxL, 0xffffff),
        trail: cannon ? [] : [sprite(T!.streak, fxL, sh.color), sprite(T!.streak, fxL, sh.color), sprite(T!.streak, fxL, sh.color)],
        glow: sprite(T!.glow, fxL, missile ? 0xffa050 : sh.color),
      };
      if (missile) {
        s.ropePts = Array.from({ length: ROPE }, () => new Point());
        s.rope = new MeshRope({ texture: T!.trail, points: s.ropePts, textureScale: 0 });
        s.rope.tint = 0xb0a89c; s.rope.alpha = 0; smokeL.addChild(s.rope);
        s.hotPts = Array.from({ length: HOT }, () => new Point());
        s.hot = new MeshRope({ texture: T!.trail, points: s.hotPts, textureScale: 0 });
        s.hot.tint = 0xffa050; s.hot.alpha = 0; fxL.addChild(s.hot);
        s.fire = sprite(T!.fire[0]!, fxL); s.flash = sprite(T!.glow, fxL, 0xfff0d0);
        s.embers = Array.from({ length: 7 }, () => sprite(T!.spark, fxL, 0xffffff, 1, 0.5));
      }
      slots.push(s);
    }
    const muzzle = sprite(T!.glow, fxL, lerpRgb(sh.color, 0xffffff, 0.4));
    const im = mkImpact(sh.color, cannon ? 3 : 0);
    shotViews.push({ sh, draw: (t) => {
      geo(sh, t, G);
      const flight = flightOf(G);
      const nNow = Math.floor((t - sh.t0) / per);
      const sinceFire = t - (sh.t0 + Math.max(0, nNow) * per);
      muzzle.position.set(G.mx, G.my);
      muzzle.scale.set((missile ? 22 : cannon ? 12 : 18) / 64);
      muzzle.alpha = G.ok && t >= sh.t0 && t <= sh.t1 ? Math.exp(-sinceFire * (cannon ? 40 : 22)) : 0;
      for (let k = 0; k < nSlots; k++) {
        const s = slots[k]!, n = nNow - k;
        s.head.alpha = 0; s.core.alpha = 0; s.glow.alpha = 0;
        for (const tr of s.trail) tr.alpha = 0;
        if (s.rope) { s.rope.alpha = 0; s.hot!.alpha = 0; s.fire!.alpha = 0; s.flash!.alpha = 0; for (const e of s.embers!) e.alpha = 0; }
        const tf = sh.t0 + n * per;
        if (n < 0 || tf > sh.t1) continue;
        const age = t - tf;
        if (age < 0) continue;
        const f = age / flight;
        if (f <= 1 && G.ok) {
          pathAt(f, n, G, pt);
          pathAt(Math.min(1, f + 0.01), n, G, tmpPt);
          const dir = Math.atan2(tmpPt.y - pt.y, tmpPt.x - pt.x);
          const L0 = missile ? 16 : cannon ? 38 : 30, Wd = missile ? 6 : cannon ? 4 : 9;
          s.head.position.set(pt.x, pt.y); s.head.rotation = dir; s.head.scale.set(L0 / 128, Wd / 32);
          s.head.alpha = missile ? 0.9 : cannon ? 1 : 0.85;
          s.core.position.set(pt.x, pt.y); s.core.rotation = dir; s.core.scale.set((L0 * 0.6) / 128, (Wd * 0.33 + 0.8) / 32); s.core.alpha = 1;
          s.glow.position.set(pt.x, pt.y); s.glow.scale.set((missile ? 26 : cannon ? 0 : 22) / 64); s.glow.alpha = cannon ? 0 : 0.55;
          for (let j = 0; j < s.trail.length; j++) {
            const ff = f - (j + 1) * (12 / Math.max(1, G.len));
            if (ff < 0) continue;
            pathAt(ff, n, G, tmpPt);
            const tr = s.trail[j]!;
            tr.position.set(tmpPt.x, tmpPt.y); tr.rotation = dir; tr.scale.set((L0 * (0.9 - j * 0.15)) / 128, (Wd * (0.8 - j * 0.18)) / 32);
            tr.alpha = 0.42 - j * 0.12;
          }
          if (missile) {
            // Smoke rope from the recent path; the hot core is just the last few points.
            for (let j = 0; j < ROPE; j++) {
              pathAt(Math.max(0, f - j * 0.014), n, G, tmpPt);
              s.ropePts![j]!.set(tmpPt.x, tmpPt.y);
            }
            for (let j = 0; j < HOT; j++) {
              pathAt(Math.max(0, f - j * 0.006), n, G, tmpPt);
              s.hotPts![j]!.set(tmpPt.x, tmpPt.y);
            }
            s.rope!.alpha = 0.5; s.hot!.alpha = 0.9;
            s.glow.alpha = 0.7 + 0.3 * Math.sin(t * 61 + k);
          }
        } else if (missile && G.ok) {
          // Detonation: fireball flipbook + flash + embers, then the smoke lingers.
          const a = age - flight;
          const fi = flipFrame(a, 0.55, T!.fire.length);
          if (fi >= 0) {
            s.fire!.texture = T!.fire[fi]!; s.fire!.position.set(G.ix, G.iy); s.fire!.scale.set(52 / 128); s.fire!.rotation = n * 1.3; s.fire!.alpha = 1;
          }
          s.flash!.position.set(G.ix, G.iy); s.flash!.scale.set(90 / 64); s.flash!.alpha = envelope(a, 0.02, 0.18) * 0.9;
          for (let j = 0; j < s.embers!.length; j++) {
            const e = s.embers![j]!, ed = n * 2.1 + j * 0.9;
            const spd = 90 + ((j * 0.37) % 1) * 120, d = (spd * (1 - Math.exp(-a * 3))) / 3;
            e.position.set(G.ix + Math.cos(ed) * d, G.iy + Math.sin(ed) * d); e.rotation = ed;
            const heat = 1 - a / 0.7;
            e.scale.set((6 + spd * Math.exp(-a * 3) * 0.06) / 32, 0.35); e.tint = emberTint(heat); e.alpha = heat > 0 ? heat : 0;
          }
          if (a < 0.9) {
            for (let j = 0; j < ROPE; j++) {
              pathAt(Math.max(0, 1 - j * 0.014), n, G, tmpPt);
              s.ropePts![j]!.set(tmpPt.x, tmpPt.y);
            }
            s.rope!.alpha = 0.5 * (1 - a / 0.9);
          }
        }
      }
      if (missile) return;
      // Impacts at the most recent arrival.
      const since = (((t - sh.t0 - flight) % per) + per) % per;
      const arrived = t - sh.t0 > flight && t - flight <= sh.t1;
      const I = arrived ? Math.exp(-since * (cannon ? 26 : 14)) : 0;
      drawImpact(im, G, I, since * 2.4, cannon ? 18 : 26);
      for (let j = 0; j < im.puffs.length; j++) {
        const p = im.puffs[j]!, a = since + j * per;
        p.position.set(G.ix + Math.cos(G.ang + Math.PI + j) * a * 18, G.iy + Math.sin(G.ang + Math.PI + j) * a * 18);
        p.scale.set((8 + a * 26) / 64); p.rotation = j * 2 + a;
        p.alpha = arrived && !G.shielded && G.ok ? 0.45 * Math.max(0, 1 - a / 0.5) : 0;
      }
      if (sh.wall !== undefined) {
        if (G.shielded && arrived) { fenceHit(sh.wall, sh.wallT ?? 0.5, since); fenceHit(sh.wall, (sh.wallT ?? 0.5) + 0.01, since + per); }
      } else if (G.shielded && arrived) {
        // Recent arrivals on the shield: the last two of this stream.
        const si = shieldOf[sh.to]!;
        const ang = Math.atan2(tmpA.y - tmpB.y, tmpA.x - tmpB.x);
        pushHit(si, ang, since, cannon ? 0.4 : 1);
        pushHit(si, ang + 0.12, since + per, cannon ? 0.4 : 0.8);
      }
    } });
  }
  const tmpPt = { x: 0, y: 0 };

  // ---- shields
  interface ShieldV {
    i: number; ring: Graphics | null; todayPulse: number;
    hits: Sprite[]; dome: Sprite | null; shards: Sprite[]; held: Sprite[]; ripples: Sprite[]; flares: Sprite[];
    mesh: Mesh<Geometry, Shader> | null; uni: UniformGroup | null; hitU: Float32Array[];
  }
  const shieldGeom = new Geometry({ attributes: { aPosition: SHIELD_QUAD_POS, aUV: SHIELD_QUAD_UV }, indexBuffer: SHIELD_QUAD_INDEX });
  const shieldProgram = NEW && SHIELD_MODE === 'shader' ? GlProgram.from({ vertex: SHIELD_VERTEX, fragment: SHIELD_FRAGMENT, name: 'shield-hit' }) : null;
  const shieldViews: ShieldV[] = scene.shields.map((sd, i) => {
    const v: ShieldV = { i, ring: null, todayPulse: -1e9, hits: [], dome: null, shards: [], held: [], ripples: [], flares: [], mesh: null, uni: null, hitU: [] };
    if (!NEW) {
      v.ring = new Graphics().circle(0, 0, sd.radius).stroke({ color: 0x88ddff, width: 2 });
      todayL.addChild(v.ring);
      return v;
    }
    if (shieldProgram) {
      v.uni = new UniformGroup({
        uHit0: { value: new Float32Array([1, 0, 99, 0]), type: 'vec4<f32>' },
        uHit1: { value: new Float32Array([1, 0, 99, 0]), type: 'vec4<f32>' },
        uHit2: { value: new Float32Array([1, 0, 99, 0]), type: 'vec4<f32>' },
        uHit3: { value: new Float32Array([1, 0, 99, 0]), type: 'vec4<f32>' },
        uTint: { value: new Float32Array([((sd.color >> 16) & 255) / 255, ((sd.color >> 8) & 255) / 255, (sd.color & 255) / 255]), type: 'vec3<f32>' },
        uBreak: { value: -1, type: 'f32' },
        uLife: { value: HIT_LIFE, type: 'f32' },
        uCells: { value: 7, type: 'f32' },
      });
      const uu = v.uni.uniforms as Record<string, Float32Array>;
      v.hitU = [uu['uHit0']!, uu['uHit1']!, uu['uHit2']!, uu['uHit3']!];
      const shader = new Shader({ glProgram: shieldProgram, resources: { shieldUniforms: v.uni } });
      const mesh = new Mesh<Geometry, Shader>({ geometry: shieldGeom, shader });
      mesh.blendMode = 'add';
      shieldL.addChild(mesh);
      v.mesh = mesh;
    } else {
      for (let k = 0; k < SHIELD_HITS; k++) v.hits.push(sprite(T!.hit[0]!, shieldL, sd.color));
      for (let k = 0; k < SHIELD_CONTACTS; k++) {
        v.held.push(sprite(T!.contact, shieldL, lerpRgb(sd.color, 0xffffff, 0.35)));
        v.ripples.push(sprite(T!.hit[0]!, shieldL, sd.color));
        v.flares.push(sprite(T!.glow, shieldL, lerpRgb(sd.color, 0xffffff, 0.6)));
      }
    }
    v.dome = sprite(T!.dome, shieldL, sd.color);
    for (let k = 0; k < 14; k++) v.shards.push(sprite(T!.spark, shieldL, sd.color, 1, 0.5));
    return v;
  });
  // ---- shield fences
  /** Wall band thickness and segment length, world units. */
  const FENCE_BAND = 24, FENCE_SEG = 42, FENCE_HIT_LIFE = 0.45;
  interface FenceV {
    fe: FxFence; len: number; ang: number; ux: number; uy: number;
    segs: Sprite[]; posts: Sprite[]; sparks: Sprite[]; hits: Sprite[]; held: Sprite[];
    gfx: Graphics | null;
    hitPos: Float32Array; hitAge: Float32Array;
  }
  const fenceContacts: ShieldContacts[] = (scene.fences ?? []).map(() => new ShieldContacts());
  const fenceViews: FenceV[] = (scene.fences ?? []).map((fe) => {
    const dx = fe.bx - fe.ax, dy = fe.by - fe.ay, len = Math.hypot(dx, dy) || 1;
    const v: FenceV = { fe, len, ang: Math.atan2(dy, dx), ux: dx / len, uy: dy / len, segs: [], posts: [], sparks: [], hits: [], held: [], gfx: null,
      hitPos: new Float32Array(SHIELD_HITS), hitAge: new Float32Array(SHIELD_HITS).fill(99) };
    if (!NEW) { v.gfx = new Graphics(); todayL.addChild(v.gfx); return v; }
    const n = Math.max(1, Math.round(len / FENCE_SEG));
    for (let k = 0; k < n; k++) { const s = sprite(T!.fenceStrip[0]!, shieldL, 0x7fd8ff, 0, 0.5); v.segs.push(s); }
    for (let k = 0; k < 2; k++) v.posts.push(sprite(T!.glow, shieldL, 0x9fe6ff));
    for (let k = 0; k < 6; k++) v.sparks.push(sprite(T!.spark, shieldL, 0xffb070, 1, 0.5));
    for (let k = 0; k < SHIELD_HITS; k++) v.hits.push(sprite(T!.fenceRipple[0]!, shieldL, 0x9fe6ff));
    for (let k = 0; k < SHIELD_CONTACTS; k++) v.held.push(sprite(T!.fenceContact, shieldL, 0xc8f2ff));
    return v;
  });
  function fenceBegin(): void {
    for (const c of fenceContacts) c.begin();
    for (const v of fenceViews) v.hitAge.fill(99);
  }
  function fenceEnd(dt: number): void { for (const c of fenceContacts) c.end(dt); }
  /** "Angle" units for the contact logic: 100 world units along the wall. */
  const FENCE_POS_UNIT = 100;
  function fenceBeam(wall: number, key: number, wt: number, t: number, sh: FxShot): void {
    const v = fenceViews[wall]!;
    const w = wt + Math.sin(t * 0.9 + sh.from) * 0.025;
    fenceContacts[wall]!.offer(key, (w * v.len) / FENCE_POS_UNIT, 1);
  }
  function fenceHit(wall: number, wt: number, age: number): void {
    const v = fenceViews[wall];
    if (!v || age < 0 || age >= FENCE_HIT_LIFE) return;
    let worst = 0;
    for (let k = 1; k < SHIELD_HITS; k++) if (v.hitAge[k]! > v.hitAge[worst]!) worst = k;
    if (age >= v.hitAge[worst]!) return;
    v.hitAge[worst] = age; v.hitPos[worst] = wt;
  }
  /** Where a fence is in its up / raising / dropping / opening cycle. */
  function fenceState(fe: FxFence, t: number): { up: boolean; raise: number; fall: number; since: number } {
    for (let i = 0; i < fe.up.length; i++) {
      const [a, b] = fe.up[i]!;
      if (t >= a && t < b) return { up: true, raise: a > 0 ? Math.min(1, (t - a) / 0.45) : 1, fall: 0, since: t - a };
    }
    // Down: how long since it last went down.
    let lastEnd = -1;
    for (const [, b] of fe.up) if (b <= t) lastEnd = Math.max(lastEnd, b);
    return { up: false, raise: 0, fall: lastEnd >= 0 ? Math.min(1, (t - lastEnd) / (fe.gate ? 0.35 : 0.3)) : 1, since: lastEnd >= 0 ? t - lastEnd : 99 };
  }
  const todayWall: ShieldWallVisual = { active: false, glowColor: 0, glowAlpha: 0, glowWidth: 0, railColor: 0, railAlpha: 0, railWidth: 0, halfThickness: 0, shimmerT: 0, shimmerColor: 0, shimmerAlpha: 0, shimmerWidth: 0 } as ShieldWallVisual;
  const comet = { x0: 0, y0: 0, x1: 0, y1: 0 };
  function drawFences(t: number): void {
    const zoom = cam.zoom;
    for (let wi = 0; wi < fenceViews.length; wi++) {
      const v = fenceViews[wi]!, fe = v.fe;
      const st = fenceState(fe, t);
      if (v.gfx) {
        // Today's look (ConnectorRenderer.drawShieldWall, per frame here).
        const g = v.gfx; g.clear();
        const ax = fe.ax, ay = fe.ay, bx = fe.bx, by = fe.by;
        if (!st.up && fe.gate) {
          for (let d = 0; d < v.len; d += 28) {
            const d1 = Math.min(v.len, d + 12);
            g.moveTo(ax + v.ux * d, ay + v.uy * d).lineTo(ax + v.ux * d1, ay + v.uy * d1);
          }
          g.stroke({ color: 0x7fe0a4, alpha: 0.45, width: Math.max(1 / zoom, 2) });
          continue;
        }
        const sv = shieldWallVisualParams(todayWall, st.up, t * 1000, zoom);
        if (!st.up) { g.moveTo(ax, ay).lineTo(bx, by).stroke({ color: sv.railColor, alpha: sv.railAlpha, width: sv.railWidth }); continue; }
        const nx = -v.uy * sv.halfThickness, ny = v.ux * sv.halfThickness;
        g.moveTo(ax, ay).lineTo(bx, by).stroke({ color: sv.glowColor, alpha: sv.glowAlpha, width: sv.glowWidth });
        g.moveTo(ax + nx, ay + ny).lineTo(bx + nx, by + ny).stroke({ color: sv.railColor, alpha: sv.railAlpha, width: sv.railWidth });
        g.moveTo(ax - nx, ay - ny).lineTo(bx - nx, by - ny).stroke({ color: sv.railColor, alpha: sv.railAlpha, width: sv.railWidth });
        const c = cometSegment(comet, sv.shimmerT, true, ax, ay, bx, by, zoom);
        g.moveTo(c.x0, c.y0).lineTo(c.x1, c.y1).stroke({ color: sv.shimmerColor, alpha: sv.shimmerAlpha, width: sv.shimmerWidth });
        continue;
      }
      // New look: a row of animated strip segments.
      const n = v.segs.length, segL = v.len / n;
      const frame = Math.floor(t * 10) % T!.fenceStrip.length;
      const breathe = 0.8 + 0.1 * Math.sin(t * 2.1 + wi);
      for (let k = 0; k < n; k++) {
        const s = v.segs[k]!;
        const c = (k + 0.5) / n, edge = Math.min(c, 1 - c);
        s.texture = T!.fenceStrip[frame]!;
        s.position.set(fe.ax + v.ux * segL * k, fe.ay + v.uy * segL * k);
        s.rotation = v.ang; s.scale.set(segL / s.texture.frame.width, FENCE_BAND / s.texture.frame.height);
        let a = 0, tint = 0x7fd8ff;
        if (st.up) {
          // Raising: grows from both posts and meets in the middle.
          a = edge <= st.raise * 0.5 + 0.02 ? breathe : 0;
          if (st.raise < 1 && Math.abs(edge - st.raise * 0.5) < 0.6 / n) { a = 1.4; tint = 0xeaffff; }
        } else if (fe.gate) {
          // Opening: pulls back into the posts, leaving a faint guide.
          a = edge < (1 - st.fall) * 0.5 ? breathe : 0.1;
          if (st.fall >= 1) { a = 0.1; tint = 0x7fe0a4; }
        } else if (st.fall < 1) {
          // Losing power: flickers out.
          a = h01(k * 31 + Math.floor(t * 30), 7) > st.fall ? 1 : 0;
        } else {
          // Down: a faint red sputter.
          tint = 0xff6a5a;
          a = h01(k * 13 + Math.floor(t * 12), 3) > 0.7 ? 0.22 : 0.06;
        }
        s.alpha = a; s.tint = tint;
      }
      for (let k = 0; k < 2; k++) {
        const p = v.posts[k]!;
        p.position.set(k ? fe.bx : fe.ax, k ? fe.by : fe.ay);
        p.scale.set(24 / 64);
        p.alpha = st.up ? 0.75 : fe.gate ? 0.45 : 0.15 + 0.2 * h01(k + Math.floor(t * 9), 5);
        p.tint = st.up || fe.gate ? 0x9fe6ff : 0xff8a6a;
      }
      // A powerless emitter spits sparks.
      for (let k = 0; k < v.sparks.length; k++) {
        const s = v.sparks[k]!;
        const on = !st.up && !fe.gate;
        const ph = (t * 2.2 + k * 0.37) % 1;
        const end = k % 2, px = end ? fe.bx : fe.ax, py = end ? fe.by : fe.ay;
        const dir = v.ang + (end ? Math.PI : 0) + (h01(k + Math.floor(t * 2.2 + k * 0.37) * 7, 9) - 0.5) * 1.6;
        s.position.set(px + Math.cos(dir) * ph * 26, py + Math.sin(dir) * ph * 26); s.rotation = dir;
        s.scale.set(10 / 32, 0.35); s.tint = emberTint(1 - ph);
        s.alpha = on && h01(k + Math.floor(t * 2.2 + k * 0.37) * 3, 11) > 0.45 ? 1 - ph : 0;
      }
      // Bolt ripples along the wall.
      for (let k = 0; k < SHIELD_HITS; k++) {
        const s = v.hits[k]!;
        const fi = st.up ? flipFrame(v.hitAge[k]!, FENCE_HIT_LIFE, T!.fenceRipple.length) : -1;
        if (fi < 0) { s.alpha = 0; continue; }
        const d = v.hitPos[k]! * v.len;
        s.texture = T!.fenceRipple[fi]!;
        s.position.set(fe.ax + v.ux * d, fe.ay + v.uy * d); s.rotation = v.ang;
        s.scale.set((FENCE_BAND * 128 / 48) / 128 * 2.2, (FENCE_BAND / 48) * 1.15);
        s.alpha = 1;
      }
      // Held laser contacts.
      const fc = fenceContacts[wi]!;
      for (let k = 0; k < SHIELD_CONTACTS; k++) {
        const s = v.held[k]!;
        const I = st.up ? fc.intensity(k) : 0;
        if (I <= 0) { s.alpha = 0; continue; }
        const d = fc.ang[k]! * FENCE_POS_UNIT;
        s.position.set(fe.ax + v.ux * d, fe.ay + v.uy * d); s.rotation = v.ang;
        s.scale.set(((FENCE_BAND * 128 / 48) / 128) * 0.9, (FENCE_BAND / 48) * 1.05);
        s.alpha = Math.min(1, I * 0.8 * (0.85 + 0.15 * Math.sin(t * 11 + k * 1.7) * Math.sin(t * 4.3 + k)));
      }
    }
  }

  function pulseToday(shipIdx: number, since: number): void {
    const si = shieldOf[shipIdx]!;
    if (si >= 0) shieldViews[si]!.todayPulse = Math.max(shieldViews[si]!.todayPulse, curT - since);
  }

  // ---- explosions
  const SIZES: Record<BoomSize, { R: number; life: number; embers: number; smoke: number; sub: number }> = {
    small: { R: 42, life: 0.6, embers: 8, smoke: 3, sub: 0 },
    ship: { R: 105, life: 1.0, embers: 18, smoke: 6, sub: 3 },
    large: { R: 230, life: 1.35, embers: 28, smoke: 9, sub: 5 },
  };
  interface BoomV {
    x: number; y: number; t0: number; k: (typeof SIZES)[BoomSize];
    flash?: Sprite; fire?: Sprite; subs?: Sprite[]; ring?: Sprite; embers?: Sprite[]; smoke?: Sprite[];
    scrap: Array<{ s: Sprite; g: Sprite | null; frames: Texture[]; cx: number; cy: number; spin: number; density: number }>;
    gfx?: Graphics; dots?: Graphics[];
  }
  const booms: BoomV[] = scene.booms.map((bm, bi) => {
    let x = bm.x, y = bm.y;
    if (bm.ship !== undefined) { scene.ships[bm.ship]!.pose(bm.t0, tmpA); x = tmpA.x; y = tmpA.y; }
    const k = SIZES[bm.size];
    const v: BoomV = { x, y, t0: bm.t0, k, scrap: [] };
    if (bm.ship !== undefined) {
      for (const p of scrapFor(scene.ships[bm.ship]!.id)) {
        const s = new Sprite(p.frames[0]!); s.anchor.set(0.5); s.scale.set(1 / p.density); s.visible = false; wreckL.addChild(s);
        v.scrap.push({ s, g: T ? sprite(T.glow, glowL, 0xff8a40) : null, frames: p.frames, cx: p.cx, cy: p.cy, spin: (((bi + v.scrap.length) % 5) - 2) * 0.6, density: p.density });
      }
    }
    if (!NEW) {
      v.gfx = bm.size === 'small' ? buildMissileExplosionGfx() : buildExplosionGfx();
      v.gfx.visible = false; todayL.addChild(v.gfx);
      v.dots = Array.from({ length: bm.size === 'small' ? 0 : 14 }, () => {
        const d = new Graphics().circle(0, 0, 2).fill(0xffaa44); d.visible = false; todayL.addChild(d); return d;
      });
      return v;
    }
    v.smoke = Array.from({ length: k.smoke }, () => sprite(T!.smoke, smokeL, 0x2e2a27));
    v.subs = Array.from({ length: k.sub }, () => sprite(T!.fire[0]!, fxL));
    v.fire = sprite(T!.fire[0]!, fxL);
    v.ring = sprite(T!.ring, fxL, 0xffd6a8);
    v.embers = Array.from({ length: k.embers }, () => sprite(T!.spark, fxL, 0xffffff, 1, 0.5));
    v.flash = sprite(T!.glow, fxL, 0xfff2d8);
    return v;
  });

  // ---- per-frame
  const cam: Cam = { x: 0, y: 0, zoom: 1 };
  const xf: TileXf = { scale: 1, x: 0, y: 0 };
  const fakeCam = { center: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, screenWidth: W, screenHeight: H };
  let curT = 0;
  const glowScale = 1 / 64;

  function update(t: number): void {
    curT = t;
    scene.camera(t, cam);
    const zoom = cam.zoom;
    world.scale.set(zoom);
    world.position.set(W / 2 - cam.x * zoom, H / 2 - cam.y * zoom);

    // Backdrop.
    if (starfield) {
      fakeCam.center.x = cam.x; fakeCam.center.y = cam.y; fakeCam.scale.x = zoom; fakeCam.scale.y = zoom;
      starfield.update(fakeCam as never);
    }
    for (const tl of tiles) {
      backdropXf(cam.x, cam.y, zoom, tl.parallax, tl.zoomPow, W, H, xf);
      tl.s.tileScale.set(xf.scale * tl.texScale);
      tl.s.tilePosition.set(xf.x, xf.y);
      tl.s.alpha = tl.alpha * (tl.win ? zoomWindow(zoom, tl.win[0], tl.win[1], tl.win[2], tl.win[3]) : 1);
    }
    for (let i = 0; i < skySprites.length; i++) {
      const ss = skySprites[i]!;
      backdropXf(cam.x, cam.y, zoom, ss.parallax, ss.zoomPow, W, H, xf);
      ss.s.position.set(xf.x + ss.lx * xf.scale, xf.y + ss.ly * xf.scale);
      ss.s.scale.set((ss.size * xf.scale) / ss.s.texture.width);
      const tw = ss.tw ? 0.75 + 0.25 * Math.sin(t * (1.3 + i * 0.37) + i * 2.1) : 1;
      ss.s.alpha = ss.alpha * tw;
    }

    // Environment.
    for (const r of rocks) {
      for (let k = 0; k < r.glints.length; k++) {
        const g = r.glints[k]!;
        g.position.set(r.gxy[k * 2]!, r.gxy[k * 2 + 1]!);
        const s = Math.sin(t * (0.9 + k * 0.4) + r.ph * 5 + k * 2);
        g.alpha = Math.pow(Math.max(0, s), 10);
        g.scale.set((10 + 10 * g.alpha) / 64);
      }
    }
    for (const w of wisps) { w.s.rotation = w.rot + t * 0.01; w.s.alpha = 0.34; }
    for (const p of wreckParts) {
      p.s.position.set(p.x + p.dx * t, p.y + p.dy * t);
      const rot = p.rot + p.spin * t;
      p.s.rotation = rot;
      let u = (((rig.sunAz - rot) / (Math.PI * 2)) * SUN_STEPS) % SUN_STEPS; if (u < 0) u += SUN_STEPS;
      p.s.texture = p.frames[Math.round(u) % SUN_STEPS]!;
    }
    for (const s of wreckSparks) {
      s.s.position.set(s.x, s.y);
      const f = Math.sin(t * 13 + s.ph) * Math.sin(t * 7.3 + s.ph * 2);
      s.s.alpha = f > 0.6 ? f : 0; s.s.scale.set(10 * glowScale);
    }

    // Ships.
    for (let i = 0; i < ships.length; i++) {
      const v = ships[i]!;
      scene.ships[i]!.pose(t, v.pose);
      const p = v.pose, art = v.art;
      const alive = t < v.deadAt;
      v.a.visible = alive; v.b.visible = alive;
      const localAz = rig.sunAz - p.rot;
      let u = (localAz / (Math.PI * 2)) * SUN_STEPS;
      u = ((u % SUN_STEPS) + SUN_STEPS) % SUN_STEPS;
      const j0 = Math.floor(u), fr = u - j0;
      v.a.texture = art.frames[j0]!; v.b.texture = art.frames[(j0 + 1) % SUN_STEPS]!; v.b.alpha = fr;
      v.a.position.set(p.x, p.y); v.b.position.set(p.x, p.y); v.a.rotation = p.rot; v.b.rotation = p.rot;
      for (let n = 0; n < v.nozzles.length; n++) {
        const nz = art.nozzles[n]!;
        local(p, nz.x, nz.y + nz.r * 0.4, pt);
        const s = v.nozzles[n]!;
        s.position.set(pt.x, pt.y);
        s.scale.set(nz.r * 3.2 * glowScale * (0.6 + 0.6 * p.thrust) * (0.85 + 0.15 * Math.sin(t * 47 + v.phase * 20 + n)));
        s.alpha = alive ? 0.55 + 0.45 * p.thrust : 0;
      }
    }

    // Weapons (also gathers shield hits).
    hitAge.fill(99);
    hitPow.fill(0);
    for (const c of contacts) c.begin();
    fenceBegin();
    for (const v of shotViews) v.draw(t);
    const dt = lastT < 0 ? 0 : Math.min(0.1, Math.max(0, t - lastT));
    lastT = t;
    for (const c of contacts) c.end(dt);
    fenceEnd(dt);
    drawFences(t);

    // Shields.
    for (const v of shieldViews) {
      const sd = scene.shields[v.i]!;
      const sp = ships[sd.ship]!.pose;
      const up = shieldUp(sd.ship, t) && t < ships[sd.ship]!.deadAt;
      if (v.ring) {
        v.ring.position.set(sp.x, sp.y);
        const pulse = 0.55 * Math.exp(-Math.max(0, t - v.todayPulse) / 0.25);
        v.ring.alpha = up ? 0.18 + 0.08 * Math.sin(t * (Math.PI * 2 / 1.4)) + pulse : 0;
        v.todayPulse = -1e9;
        continue;
      }
      const o = v.i * SHIELD_HITS;
      const dScale = sd.radius / ((T!.hit[0]!.width / 2) * 0.94);
      if (v.mesh && v.uni) {
        const u = v.uni.uniforms as Record<string, Float32Array | number>;
        let act = 0;
        for (let k = 0; k < SHIELD_HITS; k++) {
          const h = v.hitU[k]!;
          h[0] = Math.cos(hitAng[o + k]!); h[1] = Math.sin(hitAng[o + k]!); h[2] = up ? hitAge[o + k]! : 99; h[3] = hitPow[o + k]!;
          act += hitAge[o + k]! < HIT_LIFE ? 1 : 0;
        }
        const ba = sd.breakAt !== undefined ? t - sd.breakAt : -1;
        u['uBreak'] = ba;
        v.uni.update();
        v.mesh.position.set(sp.x, sp.y);
        v.mesh.scale.set(sd.radius / 0.94);
        v.mesh.visible = (up && act > 0) || (ba >= 0 && ba < 0.7);
      } else {
        for (let k = 0; k < SHIELD_HITS; k++) {
          const s = v.hits[k]!;
          const fi = up ? flipFrame(hitAge[o + k]!, HIT_LIFE, T!.hit.length) : -1;
          if (fi < 0) { s.alpha = 0; continue; }
          s.texture = T!.hit[fi]!;
          s.position.set(sp.x, sp.y); s.rotation = hitAng[o + k]!; s.scale.set(dScale); s.alpha = Math.min(1, hitPow[o + k]!);
        }
        // Held beam contacts: a steady lit patch per beam, shimmering, plus a
        // gentle ripple leaving it every 0.6 s.
        const sc = contacts[v.i]!;
        for (let k = 0; k < SHIELD_CONTACTS; k++) {
          const I = up ? sc.intensity(k) : 0;
          const h = v.held[k]!, rp = v.ripples[k]!;
          const fl = v.flares[k]!;
          if (I <= 0) { h.alpha = 0; rp.alpha = 0; fl.alpha = 0; continue; }
          const a = sc.ang[k]!;
          // The hot point where the beam meets the shield.
          const sh2 = 0.9 + 0.1 * Math.sin(t * 23 + k * 3);
          // (The per-beam hot point is drawn by the beam itself; this one only
          // adds a soft bloom over the shared patch.)
          fl.position.set(sp.x + Math.cos(a) * sd.radius * 0.96, sp.y + Math.sin(a) * sd.radius * 0.96);
          fl.scale.set((44 / 64) * sh2);
          fl.alpha = Math.min(1, I) * 0.35;
          h.position.set(sp.x, sp.y); h.rotation = a + 0.025 * Math.sin(t * 5 + k * 2); h.scale.set(dScale);
          h.alpha = Math.min(1.25, I * (0.82 + 0.18 * Math.sin(t * 11 + k * 1.7) * Math.sin(t * 4.3 + k)));
          const rf = flipFrame(sc.held[k]! % 0.6, HIT_LIFE, T!.hit.length);
          rp.alpha = rf >= 0 ? Math.min(1, I) * 0.4 : 0;
          if (rf >= 0) { rp.texture = T!.hit[rf]!; rp.position.set(sp.x, sp.y); rp.rotation = a; rp.scale.set(dScale); }
        }
      }
      // Break: dome flare (sprite variant draws it here; the shader draws its own) + shards.
      const ba = sd.breakAt !== undefined ? t - sd.breakAt : -1;
      const dome = v.dome!;
      dome.position.set(sp.x, sp.y);
      dome.scale.set((sd.radius / (128 * 0.94)) * (1 + Math.max(0, ba) * 0.5));
      dome.alpha = !v.mesh && ba >= 0 ? envelope(ba, 0.03, 0.55) * 0.95 : 0;
      for (let k = 0; k < v.shards.length; k++) {
        const s = v.shards[k]!;
        const a = k * 2.399, spd = 120 + ((k * 0.53) % 1) * 160;
        const d = sd.radius + (spd * (1 - Math.exp(-Math.max(0, ba) * 3))) / 3;
        s.position.set(sp.x + Math.cos(a) * d, sp.y + Math.sin(a) * d); s.rotation = a;
        s.scale.set(14 / 32, 0.4);
        s.alpha = ba >= 0 && ba < 0.8 ? 1 - ba / 0.8 : 0;
      }
    }

    // Explosions.
    for (const b of booms) {
      const age = t - b.t0, k = b.k;
      for (const sc of b.scrap) {
        const on = age >= 0;
        sc.s.visible = on;
        if (!on) { if (sc.g) sc.g.alpha = 0; continue; }
        const dl = Math.hypot(sc.cx, sc.cy) || 1;
        const push = 60 * (1 - Math.exp(-age * 1.6));
        const x = b.x + sc.cx + (sc.cx / dl) * push, y = b.y + sc.cy + (sc.cy / dl) * push;
        const rot = sc.spin * age;
        sc.s.position.set(x, y); sc.s.rotation = rot;
        let u = (((rig.sunAz - rot) / (Math.PI * 2)) * SUN_STEPS) % SUN_STEPS; if (u < 0) u += SUN_STEPS;
        sc.s.texture = sc.frames[Math.round(u) % SUN_STEPS]!;
        sc.s.tint = NEW ? lerpRgb(0xffb878, 0xffffff, Math.min(1, age / 1.4)) : 0xffffff;
        if (sc.g) { sc.g.position.set(x, y); sc.g.scale.set(40 * glowScale); sc.g.alpha = Math.max(0, 0.8 - age * 0.6); }
      }
      if (b.gfx) {
        const on = age >= 0 && age < 0.6;
        b.gfx.visible = on; b.gfx.position.set(b.x, b.y);
        b.gfx.scale.set((k.R / 30) * (0.6 + age * 2)); b.gfx.alpha = 1 - age / 0.6;
        for (let j = 0; j < b.dots!.length; j++) {
          const d = b.dots![j]!, a = (j / b.dots!.length) * Math.PI * 2;
          d.visible = age >= 0 && age < 0.8;
          d.position.set(b.x + Math.cos(a) * age * k.R * 1.6, b.y + Math.sin(a) * age * k.R * 1.6); d.alpha = 1 - age / 0.8;
        }
        continue;
      }
      const R = k.R;
      b.flash!.position.set(b.x, b.y); b.flash!.scale.set((R * 3.4) / 64); b.flash!.alpha = envelope(age, 0.015, 0.3) * 0.6;
      const fi = flipFrame(age, k.life, T!.fire.length);
      b.fire!.alpha = fi >= 0 ? 0.9 : 0;
      if (fi >= 0) { b.fire!.texture = T!.fire[fi]!; b.fire!.position.set(b.x, b.y); b.fire!.scale.set((R * 2) / 128); b.fire!.rotation = b.t0 * 3; }
      for (let j = 0; j < b.subs!.length; j++) {
        const s = b.subs![j]!, d0 = 0.05 + j * 0.07, a = b.t0 * 5 + j * 2.4;
        const sfi = flipFrame(age - d0, k.life * 0.75, T!.fire.length);
        s.alpha = sfi >= 0 ? 0.7 : 0;
        if (sfi >= 0) { s.texture = T!.fire[sfi]!; s.position.set(b.x + Math.cos(a) * R * 0.55, b.y + Math.sin(a) * R * 0.55); s.scale.set((R * 1.15) / 128); s.rotation = a; }
      }
      const ra = Math.max(0, age);
      b.ring!.position.set(b.x, b.y); b.ring!.scale.set((R * 0.35 + ra * R * 2.8) / 64);
      b.ring!.alpha = age >= 0 ? Math.max(0, 0.6 - ra * 1.1) : 0;
      for (let j = 0; j < b.embers!.length; j++) {
        const e = b.embers![j]!, ed = b.t0 * 7 + j * 2.399;
        const spd = (0.7 + ((j * 0.618) % 1)) * R * 2.4;
        const d = (spd * (1 - Math.exp(-ra * 2.4))) / 2.4;
        e.position.set(b.x + Math.cos(ed) * d, b.y + Math.sin(ed) * d); e.rotation = ed;
        const heat = 1 - ra / (k.life * 1.5);
        e.scale.set((5 + spd * Math.exp(-ra * 2.4) * 0.045) / 32, 0.42); e.tint = emberTint(heat);
        e.alpha = age >= 0 && heat > 0 ? Math.min(1, heat * 1.4) : 0;
      }
      for (let j = 0; j < b.smoke!.length; j++) {
        const s = b.smoke![j]!, a = b.t0 * 3 + j * 2.1;
        const d = R * 0.45 * (1 - Math.exp(-ra * 1.3)) + ra * 6;
        s.position.set(b.x + Math.cos(a) * d, b.y + Math.sin(a) * d);
        s.scale.set((R * 1.1 * (0.7 + ra * 0.5)) / 64); s.rotation = a + ra * 0.15;
        s.alpha = 0.55 * envelope(age - 0.12, 0.35, 3.2);
      }
    }
    app.render();
  }

  // ---- harness API
  let drawCalls = 0;
  const gl = (app.renderer as unknown as { gl?: WebGL2RenderingContext }).gl;
  if (gl) {
    const de = gl.drawElements.bind(gl), da = gl.drawArrays.bind(gl);
    gl.drawElements = ((...a: Parameters<typeof de>) => { drawCalls++; de(...a); }) as typeof gl.drawElements;
    gl.drawArrays = ((...a: Parameters<typeof da>) => { drawCalls++; da(...a); }) as typeof gl.drawArrays;
  }
  const api = {
    ready: true, arm: ARM, scene: SCENE, duration: scene.duration,
    seek(ms: number): void {
      const t = ms / 1000;
      if (lastT < 0 || t < lastT || t - lastT > 0.1) for (const c of fenceContacts) c.clear();
      // Contacts fade over time: when jumping, run the last 0.4 s first so a
      // still shows the same state as the clip.
      if (lastT < 0 || t < lastT || t - lastT > 0.1) {
        lastT = -1;
        for (const c of contacts) c.clear();
        for (let k = 24; k >= 1; k--) update(Math.max(0, t - k / 60));
      }
      update(t);
    },
    stats() {
      drawCalls = 0; update(curT);
      return {
        arm: ARM, scene: SCENE, shield: SHIELD_MODE, neb: NEB, t: curT,
        artBakeMs: Math.round(artBakeMs), fxBakeMs: Math.round(fxBakeMs), fxBakeEach: bakeMs,
        fxTextureBytes: imgGpuBytes(fxImgs), drawCallsPerFrame: drawCalls,
        sprites: countNodes(app.stage), ships: ships.length,
      };
    },
    bench(ms: number): Promise<{ frames: number; cpuP50: number; cpuP95: number; rafP50: number; rafP95: number; drawCalls: number }> {
      return new Promise((resolve) => {
        const cpu: number[] = [], raf: number[] = [];
        const start = performance.now();
        let last = start, t = 0, dc = 0;
        const step = (): void => {
          const now = performance.now();
          raf.push(now - last); last = now;
          drawCalls = 0;
          const c0 = performance.now();
          update(t % scene.duration); t += 1 / 60;
          gl?.finish();
          cpu.push(performance.now() - c0);
          dc = Math.max(dc, drawCalls);
          if (now - start < ms) requestAnimationFrame(step);
          else {
            const q = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]!; };
            raf.shift();
            resolve({ frames: cpu.length, cpuP50: q(cpu, 0.5), cpuP95: q(cpu, 0.95), rafP50: q(raf, 0.5), rafP95: q(raf, 0.95), drawCalls: dc });
          }
        };
        requestAnimationFrame(step);
      });
    },
  };
  (window as unknown as { __artlab: typeof api }).__artlab = api;
  update(0);
}

function countNodes(c: Container): number {
  let n = 0;
  for (const ch of c.children) n += 1 + countNodes(ch as Container);
  return n;
}

void main().catch((err: unknown) => {
  (window as unknown as { __artlabError: string }).__artlabError = String((err as Error)?.stack ?? err);
});
