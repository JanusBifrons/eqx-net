/**
 * The new backdrop (plan iridescent-seeking-rainbow v3 B2, v5 C1).
 *
 * Layers, far to near (the depth ladder in depth.ts):
 *  - the sector's far nebula tile and dark lanes;
 *  - far stars; far nebula patches and galaxies from the sector's sky;
 *  - the sun, along the direction the hulls are lit from;
 *  - mid stars, bright spike stars;
 *  - the sector's planets, gas giants and moons, which drift past as you
 *    travel. They sit on an endless grid seeded from the sector key
 *    (`visitSkyLayer`), so the sky never runs out and its density doesn't
 *    depend on how big a sector is (sector sizes are arbitrary and will grow);
 *  - near stars; near dust motes;
 *  - (in front of the world) fore dust motes.
 *
 * Every texture is made once (art/fx/fxTextures.ts via `ArtService.fx`) and
 * only moved and scaled per frame. Until the star tiles are baked, `update`
 * returns false and the caller keeps drawing today's starfield.
 *
 * Per frame: scalar writes on pooled sprites only (invariant #14).
 */
import { Container, Sprite, TilingSprite, type Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { hashStr } from '../raster.js';
import { backdropXf, zoomWindow, type TileXf } from './fxMath.js';
import { hashKey, landmarkScreen, sectorSky, SKY_LAYERS, visitSkyLayer, type Landmark } from './depth.js';
import { h01 } from './fxTextures.js';

export interface BackdropCamera {
  readonly center: { x: number; y: number };
  readonly scale: { x: number };
  readonly screenWidth: number;
  readonly screenHeight: number;
}

/** Which nebula a sector gets, from its key (stable between visits). */
export interface SectorNebula { variant: 'emission' | 'reflection' | 'dark'; seed: number; alpha: number }

const NEBULA_VARIANTS = ['emission', 'reflection', 'dark'] as const;
/** Layer strength by type. The red-pink emission one is kept faint (user pick).
 *  A dark-dust sector is a faint blue glow crossed by dark lanes: dust only
 *  reads as dark against something bright behind it. */
const NEBULA_ALPHA: Record<SectorNebula['variant'], number> = { emission: 0.48, reflection: 0.72, dark: 0.4 };
const LANES_ALPHA: Record<SectorNebula['variant'], number> = { emission: 0.55, reflection: 0, dark: 0.8 };

export function sectorNebula(sectorKey: string | null): SectorNebula {
  const h = hashStr(`nebula:${sectorKey ?? 'none'}`);
  const variant = NEBULA_VARIANTS[h % NEBULA_VARIANTS.length]!;
  // Seeds are kept small and few, so most sectors share cached textures.
  return { variant, seed: 1 + ((h >>> 8) % 12), alpha: NEBULA_ALPHA[variant] };
}

/** Most landmarks of one kind on screen at once (pool size per sky layer). */
const PER_LAYER = 8;
/** Texture variants per sky layer (galaxy, patch, gas giant, planet, moon). */
const VARIANTS = [4, 6, 5, 5, 3];
const NEAR_MOTES = 60;
const FORE_MOTES = 26;

interface Tile {
  s: TilingSprite; h: ArtHandle | null;
  parallax: number; zoomPow: number; texScale: number; alpha: number;
  win: [number, number, number, number] | null;
}

interface SkySprite { s: Sprite; h: ArtHandle; lx: number; ly: number; parallax: number; zoomPow: number; size: number; alpha: number; twinkle: boolean }

interface LayerPool { sprites: Sprite[]; handles: ArtHandle[]; used: number; blend: 'add' | 'normal'; alpha: number }

interface Mote { s: Sprite; lx: number; ly: number; size: number; alpha: number }

/** The texture job for variant `v` of sky layer `li` (see SKY_LAYERS). */
function layerJob(li: number, v: number): { id: 'planet' | 'wisp' | 'galaxy'; variant?: string; seed: number } {
  switch (SKY_LAYERS[li]!.kind) {
    case 'galaxy': return { id: 'galaxy', seed: 5 + v };
    case 'nebulaPatch': return { id: 'wisp', seed: 33 + v * 7 };
    case 'gasGiant': return { id: 'planet', variant: 'gas', seed: v };
    case 'planet': return { id: 'planet', variant: 'rock', seed: v };
    case 'moon': return { id: 'planet', variant: 'moon', seed: v };
  }
}

export class Backdrop {
  /** Behind the world. */
  readonly sky = new Container();
  /** In front of the world (dust). */
  readonly fore = new Container();
  private readonly tiles: Tile[] = [];
  private readonly sprites: SkySprite[] = [];
  private readonly nebula: Tile;
  private readonly far: Tile;
  private readonly lanes: Tile;
  /** Far landmarks (patches, galaxies) and near ones (planets, moons). */
  private readonly farLands = new Container();
  private readonly nearLands = new Container();
  private readonly pools: LayerPool[] = [];
  private skySeed = 0;
  private readonly scratchL: Landmark = { kind: 'planet', wx: 0, wy: 0, parallax: 0, size: 0, tint: 0, seed: 0 };
  /** Per-frame inputs for the landmark visitor (set before each layer walk). */
  private vLayer = 0;
  private vCx = 0; private vCy = 0; private vZoom = 1; private vW = 0; private vH = 0;
  private readonly visitLandmark = (l: Landmark): void => {
    const pool = this.pools[this.vLayer]!;
    if (pool.used >= pool.sprites.length) return;
    const tex = readyTex(pool.handles[l.seed % pool.handles.length]!);
    if (!tex) return;
    landmarkScreen(l, this.vCx, this.vCy, this.vZoom, SKY_LAYERS[this.vLayer]!.zoomPow, this.vW, this.vH, this.lp);
    const half = (l.size * this.lp.scale) / 2;
    if (this.lp.x < -half || this.lp.x > this.vW + half || this.lp.y < -half || this.lp.y > this.vH + half) return;
    const sp = pool.sprites[pool.used++]!;
    sp.visible = true;
    if (sp.texture !== tex) sp.texture = tex;
    sp.position.set(this.lp.x, this.lp.y);
    sp.scale.set((l.size * this.lp.scale) / tex.width);
    sp.tint = l.kind === 'nebulaPatch' ? l.tint : 0xffffff;
  };
  private readonly nearMotes: Mote[] = [];
  private readonly foreMotes: Mote[] = [];
  private readonly glow: ArtHandle;
  private readonly xf: TileXf = { scale: 1, x: 0, y: 0 };
  private readonly lp = { x: 0, y: 0, scale: 1 };
  private nebulaFor = '\u0000';
  private t = 0;
  /** Landmarks drawn last frame (stats). */
  visibleLandmarks = 0;
  /** This sector's sky, e.g. "planet@1200,-800 moon@..." (stats / E2E). */
  skySignature = '';

  constructor(private readonly art: ArtService, private readonly getQuality: () => string) {
    this.sky.eventMode = 'none';
    this.fore.eventMode = 'none';
    this.fore.blendMode = 'add';
    this.glow = art.fx('glow', undefined, undefined, false);
    this.nebula = this.tile(null, 0.012, 0.08, 2.6, 0.6, 'add', this.sky, null);
    this.far = this.tile(art.fx('starsFar', undefined, undefined, false), 0.03, 0.1, 1, 0.95, 'add', this.sky, null);
    this.sky.addChild(this.farLands);
    // The sun sits far out along the light direction, so it agrees with the hulls.
    const az = art.lightRig.sunAz;
    this.sprite(art.fx('sun', undefined, undefined, false), Math.cos(az) * 700, Math.sin(az) * 700, 0.004, 0.03, 520, 0.95, false).s.tint = 0xfff0d8;
    this.tile(art.fx('starsMid', undefined, undefined, false), 0.08, 0.25, 1, 0.9, 'add', this.sky, null);
    // Dark lanes sit in front of the far stars and the glow, hiding them.
    this.lanes = this.tile(null, 0.03, 0.15, 2.2, 0.55, 'normal', this.sky, null);
    for (let i = 0; i < 7; i++) {
      const sp = this.sprite(art.fx('spikeStar', undefined, undefined, false), (((i * 0.37) % 1) - 0.5) * 2000, (((i * 0.61) % 1) - 0.5) * 1200, 0.05, 0.2, 26 + (i % 3) * 10, 0.9, true);
      sp.s.tint = i % 3 ? 0xdfe8ff : 0xffe2c0;
    }
    // Planets are nearer than the mid stars, so they hide them.
    this.sky.addChild(this.nearLands);
    this.tile(art.fx('starsNear', undefined, undefined, false), 0.18, 0.45, 1, 0.85, 'add', this.sky, [0.22, 0.45, Infinity, Infinity]);
    // One pool per sky layer; far kinds (galaxies, patches) behind the mid
    // stars, near kinds (gas giants, planets, moons) in front of them.
    for (let li = 0; li < SKY_LAYERS.length; li++) {
      const kind = SKY_LAYERS[li]!.kind;
      const far = kind === 'galaxy' || kind === 'nebulaPatch';
      const blend: 'add' | 'normal' = far ? 'add' : 'normal';
      const alpha = kind === 'galaxy' ? 0.55 : kind === 'nebulaPatch' ? 0.3 : 1;
      const handles: ArtHandle[] = [];
      for (let v = 0; v < VARIANTS[li]!; v++) { const j = layerJob(li, v); handles.push(art.fx(j.id, j.variant, j.seed, false)); }
      const sprites: Sprite[] = [];
      for (let k = 0; k < PER_LAYER; k++) {
        const sp = new Sprite(); sp.anchor.set(0.5); sp.blendMode = blend; sp.alpha = alpha; sp.visible = false;
        (far ? this.farLands : this.nearLands).addChild(sp);
        sprites.push(sp);
      }
      this.pools.push({ sprites, handles, used: 0, blend, alpha });
    }
    for (let i = 0; i < NEAR_MOTES; i++) this.nearMotes.push(this.mote(this.sky, i, 61, 2, 0.18, 0xcfdcff));
    for (let i = 0; i < FORE_MOTES; i++) this.foreMotes.push(this.mote(this.fore, i, 71, 3, 0.22, 0xe6eeff));
    this.setSector(null);
  }

  /** The sector changed: pick its nebula and lay out its sky (baked on the
   *  first visit, cached after). */
  setSector(sectorKey: string | null): void {
    const key = sectorKey ?? '';
    if (key === this.nebulaFor) return;
    this.nebulaFor = key;
    const n = sectorNebula(sectorKey);
    this.nebula.h = this.art.fx('nebula', n.variant === 'dark' ? 'reflection' : n.variant, n.seed);
    this.nebula.alpha = n.alpha;
    this.nebula.s.visible = false;
    const lanes = LANES_ALPHA[n.variant];
    this.lanes.h = lanes > 0 ? this.art.fx('nebula', 'dark', n.seed + 40) : null;
    this.lanes.alpha = lanes;
    this.lanes.s.visible = false;
    // Landmarks come from the sector seed, cell by cell, as you fly.
    this.skySeed = hashKey(`sky:${sectorKey ?? 'none'}`);
    // A sample around the centre, for stats (once per sector change).
    this.skySignature = sectorSky(sectorKey ?? 'none', 6000).slice(0, 8)
      .map((l) => `${l.kind}@${Math.round(l.wx)},${Math.round(l.wy)}`).join(' ');
  }

  /** Which nebula texture is on (variant:seed), or null before it's chosen. */
  nebulaKey(): string | null {
    const j = this.nebula.h?.job;
    return j && j.type === 'fx' ? `${j.variant ?? ''}:${j.seed ?? ''}` : null;
  }

  /** Lay the backdrop out for this frame. False while the star tiles are
   *  still baking (the caller draws today's starfield instead). */
  update(cam: BackdropCamera, nowMs: number): boolean {
    if (this.far.h?.state !== 'ready') { this.sky.visible = false; this.fore.visible = false; return false; }
    this.sky.visible = true;
    this.t = nowMs / 1000;
    const zoom = cam.scale.x, W = cam.screenWidth, H = cam.screenHeight;
    const cx = cam.center.x, cy = cam.center.y;
    const q = this.getQuality();
    for (let i = 0; i < this.tiles.length; i++) {
      const tl = this.tiles[i]!;
      const tex = readyTex(tl.h);
      if (!tex) { tl.s.visible = false; continue; }
      if (tl.s.texture !== tex) tl.s.texture = tex;
      tl.s.visible = true;
      if (tl.s.width !== W) tl.s.width = W;
      if (tl.s.height !== H) tl.s.height = H;
      backdropXf(cx, cy, zoom, tl.parallax, tl.zoomPow, W, H, this.xf);
      tl.s.tileScale.set(this.xf.scale * tl.texScale);
      tl.s.tilePosition.set(this.xf.x, this.xf.y);
      tl.s.alpha = tl.alpha * (tl.win ? zoomWindow(zoom, tl.win[0], tl.win[1], tl.win[2], tl.win[3]) : 1);
    }
    for (let i = 0; i < this.sprites.length; i++) {
      const ss = this.sprites[i]!;
      const tex = readyTex(ss.h);
      if (!tex) { ss.s.visible = false; continue; }
      if (ss.s.texture !== tex) ss.s.texture = tex;
      ss.s.visible = true;
      backdropXf(cx, cy, zoom, ss.parallax, ss.zoomPow, W, H, this.xf);
      ss.s.position.set(this.xf.x + ss.lx * this.xf.scale, this.xf.y + ss.ly * this.xf.scale);
      ss.s.scale.set((ss.size * this.xf.scale) / tex.width);
      ss.s.alpha = ss.alpha * (ss.twinkle ? 0.75 + 0.25 * Math.sin(this.t * (1.3 + i * 0.37) + i * 2.1) : 1);
    }
    // Landmarks: each sky layer's cells around the camera, pooled sprites.
    this.vCx = cx; this.vCy = cy; this.vZoom = zoom; this.vW = W; this.vH = H;
    let shown = 0;
    for (let li = 0; li < this.pools.length; li++) {
      const pool = this.pools[li]!;
      pool.used = 0;
      this.vLayer = li;
      visitSkyLayer(this.skySeed, li, cx, cy, zoom, W, H, this.scratchL, this.visitLandmark);
      for (let k = pool.used; k < pool.sprites.length; k++) pool.sprites[k]!.visible = false;
      shown += pool.used;
    }
    this.visibleLandmarks = shown;
    // Dust motes (none on low; fewer on medium).
    const glow = readyTex(this.glow);
    const nearN = !glow || q === 'low' || q === 'minimal' ? 0 : q === 'medium' ? 40 : NEAR_MOTES;
    const foreN = !glow || q === 'low' || q === 'minimal' ? 0 : q === 'medium' ? 16 : FORE_MOTES;
    this.fore.visible = foreN > 0;
    this.layoutMotes(this.nearMotes, nearN, glow, 0.4, 0.7, cx, cy, zoom, W, H);
    this.layoutMotes(this.foreMotes, foreN, glow, 1.3, 1.1, cx, cy, zoom, W, H);
    return true;
  }

  destroy(): void {
    this.sky.destroy({ children: true });
    this.fore.destroy({ children: true });
  }

  /** Motes wrap around the camera inside a square a little larger than the
   *  screen, so they never run out. */
  private layoutMotes(list: Mote[], n: number, glow: Texture | null, parallax: number, zoomPow: number,
    cx: number, cy: number, zoom: number, W: number, H: number): void {
    const s = Math.pow(Math.max(1e-3, zoom), zoomPow);
    const P = (Math.max(W, H) * 1.25) / s;
    for (let i = 0; i < list.length; i++) {
      const m = list[i]!;
      m.s.visible = i < n && glow !== null;
      if (!m.s.visible) continue;
      if (m.s.texture !== glow) m.s.texture = glow!;
      let lx = (m.lx * P - cx * parallax) % P; if (lx < 0) lx += P;
      let ly = (m.ly * P - cy * parallax) % P; if (ly < 0) ly += P;
      m.s.position.set(W / 2 + (lx - P / 2) * s, H / 2 + (ly - P / 2) * s);
      m.s.scale.set(m.size / glow!.width);
      m.s.alpha = m.alpha;
    }
  }

  private mote(parent: Container, i: number, seed: number, size: number, alpha: number, tint: number): Mote {
    const s = new Sprite(); s.anchor.set(0.5); s.blendMode = 'add'; s.tint = tint; s.visible = false;
    parent.addChild(s);
    return { s, lx: h01(i, seed), ly: h01(i, seed + 1), size: size + size * h01(i, seed + 2), alpha: alpha + 0.2 * h01(i, seed + 3) };
  }

  private tile(h: ArtHandle | null, parallax: number, zoomPow: number, texScale: number, alpha: number,
    blend: 'add' | 'normal', parent: Container, win: [number, number, number, number] | null): Tile {
    const s = new TilingSprite({ width: 1, height: 1 });
    s.blendMode = blend;
    s.visible = false;
    parent.addChild(s);
    const t: Tile = { s, h, parallax, zoomPow, texScale, alpha, win };
    this.tiles.push(t);
    return t;
  }

  private sprite(h: ArtHandle, lx: number, ly: number, parallax: number, zoomPow: number, size: number, alpha: number, twinkle: boolean): SkySprite {
    const s = new Sprite();
    s.anchor.set(0.5);
    s.blendMode = 'add';
    s.visible = false;
    this.sky.addChild(s);
    const ss: SkySprite = { s, h, lx, ly, parallax, zoomPow, size, alpha, twinkle };
    this.sprites.push(ss);
    return ss;
  }
}

function readyTex(h: ArtHandle | null): Texture | null {
  return h && h.state === 'ready' && h.fx ? h.fx.tex : null;
}
