/**
 * Art lab runtime (plan soft-leaping-truffle v5, round 1).
 *
 * Renders one deterministic scene in one style:
 *  - `current`  — today's live `Graphics` builders (the honest "before");
 *  - `machined` — forge-baked lit sprites: ships cross-fade the two nearest of
 *    SUN_STEPS baked sun angles while the hull rotates freely;
 *  - `pixel`    — forge-baked pixel frames (rotation + light baked, palette
 *    snapped, dithered, outlined) drawn on a low-res target that is
 *    nearest-upscaled. Pixel size is screen-locked per zoom band.
 *
 * Main-thread Pixi only (worker canvases capture black). Frames are a pure
 * function of `t`, so `__artlab.seek(ms)` captures are frame-exact. Nothing
 * allocates per frame: every sprite is created up front and only mutated.
 *
 * Dev-only page: /__art-lab__/index.html?style=…&scene=…&zoom=…
 */
import { Application, Container, Graphics, RenderTexture, Sprite, Texture, TilingSprite } from 'pixi.js';
import { buildShipGfxFromShape, buildStructureGfx, shapeForKind } from '../render/pixi/spriteBuilders.js';
import { ArtCache, PIXEL_ROT_STEPS, SUN_STEPS, type PixelSettings, type ShipArt, type StructArt } from './assets.js';
import { buildScene, SCENE_IDS, type Cam, type Pose, type Scene, type SceneId, type ShipE, type Shot } from './scenes.js';
import { hash01, valueNoise } from '../render/art/fields.js';
import { seedVariant, type BakeJob } from '../render/art/bake.js';
import { LitScene, LitShipMesh } from '../render/art/litShipShader.js';
import { engineLightIntensity, engineLightReach, lightingFromSearch } from '../render/art/lightingSettings.js';

type Style = 'current' | 'machined' | 'pixel' | 'lit';

const qs = new URLSearchParams(location.search);
const STYLE = (['current', 'machined', 'pixel', 'lit'].includes(qs.get('style') ?? '') ? qs.get('style') : 'machined') as Style;
/** `lit`: ships lit on the GPU (R&D); everything else as `machined`. */
const MACHINED = STYLE === 'machined' || STYLE === 'lit';
/** `lit` lighting features (R&D): `?look=baked|f|all` and per-feature
 *  switches (lightingSettings.ts `lightingFromSearch`); `?shadow=0` is the
 *  old "no self shadow" switch. */
const LIGHTING = lightingFromSearch(qs.get('shadow') === '0' ? `${location.search}&selfshadow=0` : location.search);
/** The lights and big hulls around this frame (refilled every update). */
const litScene = new LitScene();
/** A capital is this many times taller than its baked relief (towering hulls). */
const CAPITAL_HEIGHT_FRAC = 0.12;
const SCENE = ((SCENE_IDS as readonly string[]).includes(qs.get('scene') ?? '') ? qs.get('scene') : 'ships') as SceneId;
const ZOOM = qs.has('zoom') ? Number(qs.get('zoom')) : undefined;
const BENCH_N = qs.has('n') ? Number(qs.get('n')) : 40;
const PX_OVERRIDE = qs.has('px') ? Number(qs.get('px')) : 0;
const PIX: PixelSettings = {
  steps: qs.has('steps') ? Number(qs.get('steps')) : 5,
  dither: qs.has('dither') ? Number(qs.get('dither')) : 0.35,
  outline: qs.get('outline') !== '0',
};
const TRAIL = 9;
const TRAIL_DT = 0.045;

// ---------------------------------------------------------------- textures

function canvasTex(size: number, paint: (ctx: CanvasRenderingContext2D, s: number) => void, nearest = false): Texture {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  paint(c.getContext('2d')!, size);
  const t = Texture.from(c);
  t.source.scaleMode = nearest ? 'nearest' : 'linear';
  return t;
}

/** Soft additive glow: a gaussian-ish radial falloff, white (tinted per use). */
const GLOW = canvasTex(64, (ctx, s) => {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.22)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
});

/** A horizontal streak: bright middle, soft ends and edges (bolts, beams). */
const STREAK = canvasTex(64, (ctx, s) => {
  const g = ctx.createLinearGradient(0, 0, s, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.25, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  const v = ctx.createLinearGradient(0, 0, 0, s);
  v.addColorStop(0, 'rgba(0,0,0,1)'); v.addColorStop(0.5, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = v; ctx.fillRect(0, 0, s, s);
});

/** Shockwave ring. */
const RING = canvasTex(128, (ctx, s) => {
  const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.3, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
});

/** A tile of stars (baked once). Pixel style keeps them hard single texels. */
function starTile(pixel: boolean): Texture {
  return canvasTex(512, (ctx, s) => {
    for (let i = 0; i < 260; i++) {
      const x = Math.floor(hash01(i, 11) * s), y = Math.floor(hash01(i, 23) * s);
      const b = hash01(i, 37);
      const warm = hash01(i, 41) > 0.7;
      const a = 0.25 + 0.75 * b * b;
      ctx.fillStyle = warm ? `rgba(255,214,170,${a})` : `rgba(190,210,255,${a})`;
      const r = b > 0.93 ? 2 : 1;
      if (pixel) ctx.fillRect(x, y, r, r);
      else { ctx.beginPath(); ctx.arc(x + 0.5, y + 0.5, r * 0.6, 0, Math.PI * 2); ctx.fill(); }
    }
  }, pixel);
}

/** A faint nebula (fbm value noise), baked once, stretched over the view. */
function nebulaTex(pixel: boolean): Texture {
  return canvasTex(256, (ctx, s) => {
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        let n = 0, amp = 0.5, f = 3 / s;
        for (let o = 0; o < 5; o++) { n += amp * valueNoise(x * f, y * f, 0x5eed + o); amp *= 0.5; f *= 2; }
        const m = Math.max(0, n - 0.42) * 2.2;
        const p = (y * s + x) * 4;
        const w = valueNoise(x * 2 / s, y * 2 / s, 99);
        img.data[p] = 40 + 60 * w; img.data[p + 1] = 30 + 25 * (1 - w); img.data[p + 2] = 90 + 60 * (1 - w);
        img.data[p + 3] = Math.min(255, m * m * 120);
      }
    }
    ctx.putImageData(img, 0, 0);
  }, pixel);
}

// ---------------------------------------------------------------- views

interface ShipView {
  e: ShipE;
  pose: Pose;
  /** Machined: two cross-faded lit frames. Pixel: `a` only. Current: unused. */
  a: Sprite;
  b: Sprite;
  gfx: Graphics | null;
  /** `lit` style: the GPU-lit hull. */
  lit?: LitShipMesh;
  /** `lit` style: a big hull that shades others (box half size, height). */
  occ?: { hx: number; hy: number; h: number; color: number };
  trails: Sprite[];
  nozzles: Sprite[];
  navs: Sprite[];
  art: ShipArt | null;
  /** Pixel art per zoom band (index = band + BAND_OFFSET). */
  bandArt: Array<ShipArt | undefined>;
  phase: number;
}

interface StructView {
  x: number; y: number;
  sprite: Sprite | null;
  gfx: Graphics | null;
  /** Machined: albedo copy, added on top when an explosion lights the area. */
  lit: Sprite | null;
  /** `lit` style with live-lit structures: the GPU-lit structure. */
  litMesh?: LitShipMesh;
  rot: number;
  lamps: Sprite[];
  lampXY: Array<{ x: number; y: number }>;
  art: StructArt | null;
  bandArt: Array<StructArt | undefined>;
  id: string; seed: number;
  radius: number;
}

interface BoomView {
  flash: Sprite; ring: Sprite; pool: Sprite; balls: Sprite[];
  x: number; y: number; t0: number; size: number;
}

/** One weapon stream's sprites, all created up front. */
interface ShotView {
  s: Shot;
  core: Sprite; halo: Sprite; flare: Sprite; rim: Sprite;
  bolts: Sprite[]; sparks: Sprite[];
}
const SPARKS = 6;

const BAND_OFFSET = 40;
const BALLS = 14;

/** Pixel size (screen px per art px) for a zoom; quantised by band. */
function pxFor(zoom: number): number {
  if (PX_OVERRIDE > 0) return PX_OVERRIDE;
  return zoom >= 1.5 ? 3 : zoom >= 0.6 ? 2 : 1;
}
/** Art texels per world unit for a zoom: zoom / px, snapped to quarter octaves. */
function bandFor(zoom: number): { band: number; pd: number; px: number } {
  const px = pxFor(zoom);
  const band = Math.round(Math.log2(zoom / px) * 4);
  return { band, pd: Math.pow(2, band / 4), px };
}

async function main(): Promise<void> {
  const host = document.getElementById('host')!;
  const W = Number(qs.get('w') ?? window.innerWidth) | 0;
  const H = Number(qs.get('h') ?? window.innerHeight) | 0;
  const app = new Application();
  await app.init({
    width: W, height: H, background: 0x04060d, antialias: STYLE !== 'pixel',
    // ?dpr=1 renders at the device pixel ratio, as the game does on touch.
    resolution: qs.get('dpr') === '1' ? window.devicePixelRatio || 1 : 1, autoDensity: qs.get('dpr') === '1',
    autoStart: false, preference: 'webgl', roundPixels: STYLE === 'pixel', preserveDrawingBuffer: true,
  });
  host.appendChild(app.canvas);

  const scene: Scene = buildScene(SCENE, ZOOM, BENCH_N);
  const cache = new ArtCache();
  const t0Bake = performance.now();
  // Machined: bake everything the scene needs on worker threads first
  // (`?workers=0` bakes on the main thread instead, for comparison).
  if (MACHINED && qs.get('workers') !== '0') {
    const jobs: BakeJob[] = [];
    for (const st of scene.structs) jobs.push({ type: 'struct', id: st.id, seed: seedVariant(st.seed) });
    for (const sh of scene.ships) jobs.push({ type: 'ship', id: sh.id, paint: sh.paint });
    await cache.prebake(jobs, Number(qs.get('workers') ?? 4), qs.get('persist') !== '0');
  }

  // ---- scene graph
  const sceneRoot = new Container();
  const sky = new Container();
  const world = new Container();
  sceneRoot.addChild(sky, world);
  const structL = new Container(), litL = new Container(), trailL = new Container();
  const shipL = new Container(), glowL = new Container(), fxL = new Container();
  for (const l of [litL, trailL, glowL, fxL]) l.blendMode = 'add';
  world.addChild(structL, litL, trailL, shipL, glowL, fxL);

  const pixel = STYLE === 'pixel';
  const stars = new TilingSprite({ texture: starTile(pixel), width: W, height: H });
  const nebula = new Sprite(nebulaTex(pixel));
  if (STYLE !== 'current') sky.addChild(nebula);
  sky.addChild(stars);

  // ---- pixel target
  let rt: RenderTexture | null = null;
  const rtSprite = new Sprite();
  let curPx = 0;
  const ensureRt = (px: number): void => {
    if (px === curPx && rt) return;
    curPx = px;
    rt?.destroy(true);
    rt = RenderTexture.create({ width: Math.ceil(W / px) + 2, height: Math.ceil(H / px) + 2, scaleMode: 'nearest', resolution: 1 });
    rtSprite.texture = rt;
    rtSprite.scale.set(px);
  };
  if (pixel) app.stage.addChild(rtSprite); else app.stage.addChild(sceneRoot);

  // ---- bands the camera will visit (bake ahead, so capture never hitches)
  const cam: Cam = { x: 0, y: 0, zoom: 1 };
  const bands = new Set<number>();
  if (pixel) {
    for (let t = 0; t <= scene.duration + 1e-6; t += 0.05) { scene.camera(t, cam); bands.add(bandFor(cam.zoom).band); }
  }

  const glow = (layer: Container, tint: number): Sprite => {
    const s = new Sprite(GLOW);
    s.anchor.set(0.5); s.tint = tint; s.alpha = 0;
    layer.addChild(s);
    return s;
  };

  // ---- structures
  const structs: StructView[] = scene.structs.map((st) => {
    const v: StructView = { x: st.x, y: st.y, sprite: null, gfx: null, lit: null, rot: st.rot, lamps: [], lampXY: [], art: null, bandArt: [], id: st.id, seed: st.seed, radius: 100 };
    if (STYLE === 'current') {
      v.gfx = buildStructureGfx(st.id, undefined, st.seed);
      v.gfx.position.set(st.x, st.y);
      structL.addChild(v.gfx);
      v.radius = Math.max(v.gfx.width, v.gfx.height) / 2;
      return v;
    }
    let art: StructArt;
    if (MACHINED) {
      art = cache.machinedStruct(st.id, st.seed);
      v.lit = new Sprite(art.albedo!);
      v.lit.anchor.set(0.5); v.lit.scale.set(2 / art.density); // half-res albedo v.lit.position.set(st.x, st.y);
      v.lit.alpha = 0; v.lit.tint = 0xffb070;
      litL.addChild(v.lit);
    } else {
      for (const b of bands) v.bandArt[b + BAND_OFFSET] = cache.pixelStruct(st.id, Math.pow(2, b / 4), PIX, st.seed);
      art = v.bandArt[[...bands][0]! + BAND_OFFSET]!;
    }
    v.art = art;
    v.sprite = new Sprite(art.tex);
    v.sprite.anchor.set(0.5);
    v.sprite.scale.set(1 / art.density);
    v.sprite.position.set(st.x, st.y);
    structL.addChildAt(v.sprite, 0);
    v.radius = Math.max(art.w, art.h) / art.density / 2;
    if (STYLE === 'lit' && LIGHTING.litStructures) {
      const l = cache.litStruct(st.id, st.seed);
      v.litMesh = new LitShipMesh(l.maps, l.tex, LIGHTING);
      v.litMesh.position.set(st.x, st.y);
      v.litMesh.rotation = st.rot;
      v.sprite.visible = false;
      if (v.lit) v.lit.visible = false;
      structL.addChildAt(v.litMesh, 0);
    }
    for (const l of art.navLights) {
      v.lamps.push(glow(glowL, l.color));
      v.lampXY.push({ x: st.x + l.x, y: st.y + l.y });
    }
    return v;
  });

  // ---- ships
  const ships: ShipView[] = scene.ships.map((e, i) => {
    const v: ShipView = {
      e, pose: { x: 0, y: 0, rot: 0, thrust: 0 }, a: new Sprite(), b: new Sprite(), gfx: null,
      trails: [], nozzles: [], navs: [], art: null, bandArt: [], phase: hash01(i, 5),
    };
    v.a.anchor.set(0.5); v.b.anchor.set(0.5);
    if (STYLE === 'current') {
      v.gfx = buildShipGfxFromShape(shapeForKind(e.id), e.paint);
      shipL.addChild(v.gfx);
      // Today's renderer has no baked nozzle data; reuse the forge's for the
      // shared engine glow so only the hull art differs between arms.
      v.art = cache.machinedShip(e.id, e.paint);
    } else if (STYLE === 'lit') {
      v.art = cache.machinedShip(e.id, e.paint); // nozzles + nav lights
      const l = cache.litShip(e.id, e.paint);
      v.lit = new LitShipMesh(l.maps, l.tex, LIGHTING);
      // A capital-sized hull shades the ships around it.
      const hw = l.maps.w / l.maps.ppu / 2, hh = l.maps.h / l.maps.ppu / 2;
      if (Math.max(hw, hh) >= 150) {
        v.occ = { hx: hw * 0.8, hy: hh * 0.85, h: Math.max(l.maps.maxH, Math.max(hw, hh) * 2 * CAPITAL_HEIGHT_FRAC), color: e.paint ?? 0x8a96a8 };
        v.lit.occluderId = i;
      }
      shipL.addChild(v.lit);
    } else if (STYLE === 'machined') {
      v.art = cache.machinedShip(e.id, e.paint);
      v.a.scale.set(1 / v.art.density); v.b.scale.set(1 / v.art.density);
      shipL.addChild(v.a, v.b);
    } else {
      for (const b of bands) v.bandArt[b + BAND_OFFSET] = cache.pixelShip(e.id, Math.pow(2, b / 4), PIX, e.paint);
      v.art = v.bandArt[[...bands][0]! + BAND_OFFSET]!;
      shipL.addChild(v.a);
    }
    for (const n of v.art.nozzles) {
      void n;
      v.nozzles.push(glow(glowL, 0xffa24a));
      if (e.trail) for (let k = 0; k < TRAIL; k++) v.trails.push(glow(trailL, 0xff8a3a));
    }
    if (STYLE !== 'current') for (const l of v.art.navLights) v.navs.push(glow(glowL, l.color));
    return v;
  });

  // ---- weapons
  const shotViews: ShotView[] = (scene.shots ?? []).map((sh) => {
    const mk = (tex: Texture, tint: number): Sprite => { const sp = new Sprite(tex); sp.anchor.set(0.5); sp.tint = tint; sp.alpha = 0; fxL.addChild(sp); return sp; };
    const nBolts = sh.kind === 'bolt' ? Math.ceil(1.2 / (sh.period ?? 0.3)) + 1 : 0;
    const v: ShotView = {
      s: sh,
      core: mk(STREAK, 0xffffff), halo: mk(STREAK, sh.color), flare: mk(GLOW, sh.color), rim: mk(RING, 0x7fd8ff),
      bolts: [], sparks: [],
    };
    v.core.anchor.set(0, 0.5); v.halo.anchor.set(0, 0.5);
    for (let k = 0; k < nBolts; k++) v.bolts.push(mk(STREAK, sh.color));
    for (let k = 0; k < SPARKS; k++) v.sparks.push(mk(GLOW, k % 2 ? 0xffe6b0 : sh.color));
    return v;
  });

  // ---- explosions
  const booms: BoomView[] = scene.booms.map((bm) => {
    const balls: Sprite[] = [];
    for (let k = 0; k < BALLS; k++) balls.push(glow(fxL, k % 3 === 0 ? 0xffe2a0 : 0xff7a2a));
    const ring = new Sprite(RING); ring.anchor.set(0.5); ring.alpha = 0; ring.tint = 0xffd6a0; fxL.addChild(ring);
    return { flash: glow(fxL, 0xfff4d8), ring, pool: glow(litL, 0xff9a50), balls, x: bm.x, y: bm.y, t0: bm.t0, size: bm.size };
  });

  const bakeMs = performance.now() - t0Bake;
  const scratch: Pose = { x: 0, y: 0, rot: 0, thrust: 0 };
  let curT = 0;
  let curBand = Number.NaN;

  /** Pose → world transform of a local point. */
  const local = (p: Pose, lx: number, ly: number, out: { x: number; y: number }): void => {
    const c = Math.cos(p.rot), s = Math.sin(p.rot);
    out.x = p.x + lx * c - ly * s;
    out.y = p.y + lx * s + ly * c;
  };
  const pt = { x: 0, y: 0 };

  function update(t: number): void {
    curT = t;
    litScene.begin();
    scene.camera(t, cam);
    let zoom = cam.zoom;
    let px = 1;
    if (pixel) {
      const bf = bandFor(cam.zoom);
      px = bf.px; zoom = bf.pd; // the world draws at exactly 1 art texel per RT pixel
      ensureRt(px);
      if (bf.band !== curBand) {
        curBand = bf.band;
        for (const v of ships) v.art = v.bandArt[bf.band + BAND_OFFSET] ?? v.art;
        for (const v of structs) {
          const a = v.bandArt[bf.band + BAND_OFFSET];
          if (a && v.sprite) { v.art = a; v.sprite.texture = a.tex; v.sprite.scale.set(1 / a.density); }
        }
      }
    }
    const vw = pixel ? rt!.width : W, vh = pixel ? rt!.height : H;
    world.scale.set(zoom);
    const fx = vw / 2 - cam.x * zoom, fy = vh / 2 - cam.y * zoom;
    if (pixel) {
      // Snap the world to whole art pixels; restore the remainder on upscale
      // so the camera still glides smoothly.
      const ix = Math.floor(fx), iy = Math.floor(fy);
      world.position.set(ix, iy);
      rtSprite.position.set(-px + (fx - ix) * px, -px + (fy - iy) * px);
    } else {
      world.position.set(fx, fy);
    }
    stars.width = vw; stars.height = vh;
    stars.tilePosition.set(-cam.x * zoom * 0.08, -cam.y * zoom * 0.08);
    nebula.width = vw * 1.6; nebula.height = vh * 1.6;
    nebula.position.set(-vw * 0.3 - cam.x * zoom * 0.02, -vh * 0.3 - cam.y * zoom * 0.02);

    const glowScale = 1 / 64; // GLOW texture px → world units

    // Ships.
    for (const v of ships) {
      v.e.pose(t, v.pose);
      const p = v.pose, art = v.art!;
      if (v.gfx) {
        v.gfx.position.set(p.x, p.y); v.gfx.rotation = p.rot;
      } else if (v.lit) {
        // Lit in the final pass, once every light of this frame is known.
        v.lit.position.set(p.x, p.y); v.lit.rotation = p.rot;
        if (v.occ) litScene.addOccluder(v.lit.occluderId, p.x, p.y, p.rot, v.occ.hx, v.occ.hy, v.occ.h, v.occ.color, 0.8);
      } else if (STYLE === 'machined') {
        const localAz = cache.rig.sunAz - p.rot;
        let u = (localAz / (Math.PI * 2)) * SUN_STEPS;
        u = ((u % SUN_STEPS) + SUN_STEPS) % SUN_STEPS;
        const j0 = Math.floor(u), fr = u - j0;
        v.a.texture = art.frames[j0]!; v.b.texture = art.frames[(j0 + 1) % SUN_STEPS]!;
        v.b.alpha = fr;
        v.a.position.set(p.x, p.y); v.b.position.set(p.x, p.y);
        v.a.rotation = p.rot; v.b.rotation = p.rot;
      } else {
        let k = Math.round((p.rot / (Math.PI * 2)) * PIXEL_ROT_STEPS);
        k = ((k % PIXEL_ROT_STEPS) + PIXEL_ROT_STEPS) % PIXEL_ROT_STEPS;
        v.a.texture = art.frames[k]!;
        v.a.scale.set(1 / art.density);
        v.a.position.set(p.x, p.y);
      }
      // Engines: a hot core at each nozzle, flickering deterministically.
      let ti = 0;
      for (let n = 0; n < art.nozzles.length; n++) {
        const nz = art.nozzles[n]!;
        local(p, nz.x, nz.y + nz.r * 0.4, pt);
        const fl = 0.85 + 0.15 * Math.sin(t * 47 + v.phase * 20 + n);
        const s = v.nozzles[n]!;
        s.position.set(pt.x, pt.y);
        s.scale.set(nz.r * 3.2 * glowScale * (0.6 + 0.6 * p.thrust) * fl);
        s.alpha = 0.55 + 0.45 * p.thrust;
        // GPU-lit hulls: the engine is a light (its own stern, nearby hulls).
        if (LIGHTING.engineLights && STYLE === 'lit') litScene.addLight(pt.x, pt.y, nz.r * 1.2, 0xffa24a, engineLightIntensity(nz.r, p.thrust) * fl, engineLightReach(nz.r));
        if (v.e.trail) {
          for (let k = 1; k <= TRAIL; k++) {
            v.e.pose(t - k * TRAIL_DT, scratch);
            local(scratch, nz.x, nz.y + nz.r, pt);
            const f = 1 - k / (TRAIL + 1);
            const tr = v.trails[ti++]!;
            tr.position.set(pt.x, pt.y);
            tr.scale.set(nz.r * (2.6 + k * 0.35) * glowScale);
            tr.alpha = 0.42 * f * f;
            tr.tint = k < 3 ? 0xffb35a : k < 6 ? 0xff7a34 : 0x8a5cff;
          }
        }
      }
      for (let n = 0; n < v.navs.length; n++) {
        const l = art.navLights[n]!;
        local(p, l.x, l.y, pt);
        const blink = ((t * 0.9 + v.phase + n * 0.5) % 1) < 0.14 ? 1 : 0.25;
        const s = v.navs[n]!;
        s.position.set(pt.x, pt.y); s.scale.set(5 * glowScale); s.alpha = blink;
      }
    }

    // Structure lamps: a slow, offset pulse.
    for (const v of structs) {
      for (let n = 0; n < v.lamps.length; n++) {
        const s = v.lamps[n]!, xy = v.lampXY[n]!;
        s.position.set(xy.x, xy.y);
        s.scale.set(26 * glowScale);
        s.alpha = 0.35 + 0.15 * Math.sin(t * 2.1 + n * 1.3 + v.seed);
      }
      if (v.lit) v.lit.alpha = 0;
    }

    // Weapons: beams, bolts, impact flares, shield rims.
    for (const v of shotViews) {
      const sh = v.s, a = ships[sh.from]!.pose, b = ships[sh.to]!.pose;
      const tr = ships[sh.to]!.art!;
      const hitR = (Math.max(tr.w, tr.h) / tr.density) * 0.32; // ~hull radius
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
      // Muzzle a little ahead of the shooter; impact on the near side of the target.
      const mx = a.x + ux * 10, my = a.y + uy * 10;
      const stand = hitR * (sh.shield ? 1.25 : 0.7);
      const ix = b.x - ux * stand, iy = b.y - uy * stand;
      const len = Math.hypot(ix - mx, iy - my), ang = Math.atan2(iy - my, ix - mx);
      let hitI = 0;
      if (sh.kind === 'beam') {
        const on = t >= sh.t0 && t <= sh.t1;
        const ramp = on ? Math.min(1, (t - sh.t0) * 8, (sh.t1 - t) * 8) : 0;
        const fl = 0.85 + 0.15 * Math.sin(t * 61 + sh.from);
        v.core.position.set(mx, my); v.core.rotation = ang; v.core.scale.set(len / 64, 1.6 / 64); v.core.alpha = ramp;
        v.halo.position.set(mx, my); v.halo.rotation = ang; v.halo.scale.set(len / 64, (9 * fl) / 64); v.halo.alpha = ramp * 0.7;
        hitI = ramp * fl;
      } else {
        const per = sh.period ?? 0.3, sp = sh.speed ?? 500, flight = len / sp;
        // Bolts in flight: fired at t0 + n*per, alive for `flight` seconds.
        const nNow = Math.floor((t - sh.t0) / per);
        for (let k = 0; k < v.bolts.length; k++) {
          const bo = v.bolts[k]!;
          bo.alpha = 0;
          const n = nNow - k;
          const tf = sh.t0 + n * per;
          if (n < 0 || tf > sh.t1) continue;
          const age = t - tf;
          if (age < 0 || age > flight) continue;
          const f = age / flight;
          bo.position.set(mx + (ix - mx) * f, my + (iy - my) * f);
          bo.rotation = ang; bo.scale.set(26 / 64, 6 / 64); bo.alpha = 1;
        }
        // Hit pulse: the most recent arrival.
        const sinceHit = (((t - sh.t0 - flight) % per) + per) % per;
        hitI = t - sh.t0 > flight && t - flight <= sh.t1 ? Math.exp(-sinceHit * 14) : 0;
      }
      // Lights for GPU-lit hulls: the impact, and each bolt in flight.
      if (hitI > 0.01) litScene.addLight(ix, iy, 6, sh.color, hitI * (sh.kind === 'beam' ? 2.2 : 1.6), sh.kind === 'beam' ? 70 : 50);
      if (sh.kind === 'beam' && hitI > 0.01) litScene.addLight((mx + ix) / 2, (my + iy) / 2, 6, sh.color, hitI * 0.8, len * 0.35 + 20);
      for (const bo of v.bolts) if (bo.alpha > 0) litScene.addLight(bo.x, bo.y, 5, sh.color, 0.9, 32);
      // Impact: a flare + sparks on the hull, or a rim flash on the shield.
      v.flare.position.set(ix, iy);
      v.flare.scale.set((sh.kind === 'beam' ? 22 : 16) * glowScale * (0.7 + 0.5 * hitI));
      v.flare.alpha = hitI;
      v.rim.position.set(b.x, b.y); v.rim.scale.set((hitR * 2.6) / 128);
      v.rim.alpha = sh.shield ? hitI * 0.55 : 0;
      for (let k = 0; k < SPARKS; k++) {
        const s2 = v.sparks[k]!;
        const sa = ang + Math.PI + (hash01(k, 91) - 0.5) * 2.2;
        const ph = (t * 3 + hash01(k, 93)) % 1;
        const dd = ph * (8 + hash01(k, 97) * 14);
        s2.position.set(ix + Math.cos(sa) * dd, iy + Math.sin(sa) * dd);
        s2.scale.set(3.5 * glowScale * (1 - ph));
        s2.alpha = sh.shield ? 0 : hitI * (1 - ph);
      }
    }

    // Explosions: flash, fireballs, ring, and a light pool on the base.
    for (const b of booms) {
      const age = t - b.t0;
      const on = age >= 0 && age < 2.4;
      const I = on ? Math.exp(-age * 2.4) * Math.min(1, age * 25) : 0;
      const R = 420 * b.size;
      b.flash.position.set(b.x, b.y);
      b.flash.scale.set(R * 0.7 * glowScale * (0.6 + age * 0.8));
      b.flash.alpha = I * 0.85;
      b.pool.position.set(b.x, b.y);
      b.pool.scale.set(R * 2.4 * glowScale);
      // GPU-lit hulls take the blast's real light: no fake pool on top.
      b.pool.alpha = STYLE === 'lit' && LIGHTING.pointLights > 0 ? 0 : I * 0.32;
      const ra = Math.max(0, age);
      b.ring.position.set(b.x, b.y);
      b.ring.scale.set((R * 0.25 + ra * R * 1.3) / 64);
      b.ring.alpha = on ? Math.max(0, 0.7 - ra * 0.6) : 0;
      for (let k = 0; k < BALLS; k++) {
        const s = b.balls[k]!;
        const ang = hash01(k, 71) * Math.PI * 2, sp = (0.3 + hash01(k, 73)) * R * 0.55;
        const d = sp * (1 - Math.exp(-ra * 3));
        s.position.set(b.x + Math.cos(ang) * d, b.y + Math.sin(ang) * d);
        s.scale.set(R * (0.12 + 0.12 * hash01(k, 79)) * glowScale * (1 + ra));
        s.alpha = on ? Math.max(0, Math.exp(-ra * (1.6 + hash01(k, 83))) * Math.min(1, ra * 20)) : 0;
      }
      if (I > 0.01) litScene.addLight(b.x, b.y, 25, 0xffa050, I * 5, R * 1.1);
      // Light the structures near the blast (machined: real albedo lift).
      if (I > 0.01) {
        for (const v of structs) {
          if (!v.lit) continue;
          const d = Math.hypot(v.x - b.x, v.y - b.y) - v.radius * 0.5;
          const fall = Math.max(0, 1 - d / (R * 1.6));
          v.lit.alpha = Math.min(0.55, v.lit.alpha + I * fall * fall * 0.5);
        }
      }
    }

    // GPU-lit hulls: now every light and occluder of this frame is known.
    for (const v of ships) if (v.lit) v.lit.setLight(cache.rig, v.pose.x, v.pose.y, v.pose.rot, litScene);
    for (const v of structs) if (v.litMesh) v.litMesh.setLight(cache.rig, v.x, v.y, v.rot, litScene);
    if (pixel) app.renderer.render({ container: sceneRoot, target: rt!, clear: true, clearColor: 0x04060d });
    app.render();
  }

  // ---- harness API
  const ready = true;
  const api = {
    ready,
    style: STYLE,
    scene: SCENE,
    duration: scene.duration,
    seek(ms: number): void { update(ms / 1000); },
    stats() {
      return {
        style: STYLE, scene: SCENE, bakeMs, t: curT,
        ships: ships.length, structures: structs.length,
        art: cache.stats(),
        sprites: countSprites(app.stage),
      };
    },
    /** Real RAF loop for `ms`, scene time advancing at 60 Hz per frame.
     *  Returns CPU time per frame (update + render submit) and RAF intervals. */
    bench(ms: number): Promise<{ frames: number; cpuP50: number; cpuP95: number; rafP50: number; rafP95: number }> {
      return new Promise((resolve) => {
        const cpu: number[] = [], raf: number[] = [];
        const start = performance.now();
        let last = start, t = 0;
        const gl = (app.renderer as unknown as { gl?: WebGLRenderingContext }).gl;
        const step = (): void => {
          const now = performance.now();
          raf.push(now - last); last = now;
          const c0 = performance.now();
          update(t); t += 1 / 60;
          gl?.finish();
          cpu.push(performance.now() - c0);
          if (now - start < ms) requestAnimationFrame(step);
          else {
            const q = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]!; };
            raf.shift();
            resolve({ frames: cpu.length, cpuP50: q(cpu, 0.5), cpuP95: q(cpu, 0.95), rafP50: q(raf, 0.5), rafP95: q(raf, 0.95) });
          }
        };
        requestAnimationFrame(step);
      });
    },
  };
  (window as unknown as { __artlab: typeof api }).__artlab = api;
  update(0);
}

function countSprites(c: Container): number {
  let n = 0;
  for (const ch of c.children) n += 1 + countSprites(ch as Container);
  return n;
}

void main().catch((err: unknown) => {
  (window as unknown as { __artlabError: string }).__artlabError = String(err);
});
