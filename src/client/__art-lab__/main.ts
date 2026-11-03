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
import { buildScene, SCENE_IDS, type Cam, type Pose, type Scene, type SceneId, type ShipE } from './scenes.js';
import { hash01, valueNoise } from './forge/fields.js';

type Style = 'current' | 'machined' | 'pixel';

const qs = new URLSearchParams(location.search);
const STYLE = (['current', 'machined', 'pixel'].includes(qs.get('style') ?? '') ? qs.get('style') : 'machined') as Style;
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
    width: W, height: H, background: 0x04060d, antialias: STYLE !== 'pixel', resolution: 1,
    autoStart: false, preference: 'webgl', roundPixels: STYLE === 'pixel', preserveDrawingBuffer: true,
  });
  host.appendChild(app.canvas);

  const scene: Scene = buildScene(SCENE, ZOOM, BENCH_N);
  const cache = new ArtCache();
  const t0Bake = performance.now();

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
    const v: StructView = { x: st.x, y: st.y, sprite: null, gfx: null, lit: null, lamps: [], lampXY: [], art: null, bandArt: [], id: st.id, seed: st.seed, radius: 100 };
    if (STYLE === 'current') {
      v.gfx = buildStructureGfx(st.id, undefined, st.seed);
      v.gfx.position.set(st.x, st.y);
      structL.addChild(v.gfx);
      v.radius = Math.max(v.gfx.width, v.gfx.height) / 2;
      return v;
    }
    let art: StructArt;
    if (STYLE === 'machined') {
      art = cache.machinedStruct(st.id, st.seed);
      v.lit = new Sprite(art.albedo!);
      v.lit.anchor.set(0.5); v.lit.scale.set(1 / art.density); v.lit.position.set(st.x, st.y);
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
      b.pool.alpha = I * 0.32;
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
