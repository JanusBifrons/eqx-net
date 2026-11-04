/**
 * FX lab — round 2 backdrop: depth, scale and speed (plan iridescent-seeking-rainbow v4).
 *
 * Draws the `bd=r2` arm: the depth ladder (depth.ts), the sector's
 * landmarks, nebula volumes you can fly into (slices behind AND in front of
 * the world, with a clear hole around the ship), dust motes at two depths,
 * and the speed effects at the chosen level (`speed=off|small|medium|large`).
 * Lab only; a frame is a pure function of the camera and time.
 */
import { Container, Sprite, Texture, TilingSprite } from 'pixi.js';
import { backdropXf, zoomWindow, type TileXf } from '../render/art/fx/fxMath.js';
import {
  landmarkScreen, nebulaDensityAt, sectorSky, nebulaRegions, SPEED_FX,
  type Landmark, type NebulaRegion, type SpeedFxLevel,
} from '../render/art/fx/depth.js';
import { h01, planetTex, wispTex, type Img } from '../render/art/fx/fxTextures.js';

export interface DepthTextures {
  starFar: Texture; starMid: Texture; starNear: Texture; glow: Texture; galaxy: Texture; sun: Texture;
}

interface TileL { s: TilingSprite; parallax: number; zoomPow: number; alpha: number; win: [number, number, number, number] | null; star: boolean }
interface LandV { l: Landmark; s: Sprite; zoomPow: number; alpha: number }
interface WispV { s: Sprite; wx: number; wy: number; parallax: number; zoomPow: number; size: number; alpha: number; front: boolean; region: NebulaRegion }
interface Mote { s: Sprite; lx: number; ly: number; size: number; alpha: number }

const REGION_TINT: Record<NebulaRegion['variant'], number> = { emission: 0xff6a9a, reflection: 0x6fa8ff, dark: 0x3a3048 };

export class DepthSky {
  readonly sky = new Container();
  readonly fore = new Container();
  private readonly tiles: TileL[] = [];
  private readonly lands: LandV[] = [];
  private readonly wisps: WispV[] = [];
  private readonly nearMotes: Mote[] = [];
  private readonly foreMotes: Mote[] = [];
  private readonly grade: Sprite;
  private readonly xf: TileXf = { scale: 1, x: 0, y: 0 };
  private readonly lp = { x: 0, y: 0, scale: 1 };
  readonly regions: NebulaRegion[];
  /** How deep in a nebula the camera was last frame (stats). */
  density = 0;

  constructor(T: DepthTextures, toTex: (i: Img) => Texture, skyKey: string, private readonly level: SpeedFxLevel,
    private readonly W: number, private readonly H: number, regions?: NebulaRegion[]) {
    this.sky.eventMode = 'none';
    this.fore.eventMode = 'none';
    this.regions = regions ?? nebulaRegions(skyKey);
    const tile = (tex: Texture, parallax: number, zoomPow: number, alpha: number, win: TileL['win'], star = true): void => {
      const s = new TilingSprite({ texture: tex, width: W, height: H });
      s.blendMode = 'add'; this.sky.addChild(s);
      this.tiles.push({ s, parallax, zoomPow, alpha, win, star });
    };
    // Far sky: patches and galaxies (sprites, very far).
    const sky = sectorSky(skyKey);
    const wispCache = new Map<number, Texture>();
    const wisp = (seed: number): Texture => {
      const k = seed % 6;
      let t = wispCache.get(k);
      if (!t) { t = toTex(wispTex(192, 33 + k * 7)); wispCache.set(k, t); }
      return t;
    };
    const addLand = (l: Landmark, tex: Texture, blend: 'add' | 'normal', alpha: number, zoomPow: number): void => {
      const s = new Sprite(tex); s.anchor.set(0.5); s.blendMode = blend; s.tint = l.kind === 'nebulaPatch' ? l.tint : 0xffffff; s.alpha = alpha;
      this.sky.addChild(s); this.lands.push({ l, s, zoomPow, alpha });
    };
    for (const l of sky) {
      if (l.kind === 'nebulaPatch') addLand(l, wisp(l.seed), 'add', 0.3, 0.05);
      else if (l.kind === 'galaxy') addLand(l, T.galaxy, 'add', 0.55, 0.05);
    }
    tile(T.starFar, 0.03, 0.1, 0.95, null);
    tile(T.starMid, 0.08, 0.25, 0.9, null);
    // Planets, gas giants, moons: nearer than the far stars, so they hide them.
    const tint3 = (c: number): [number, number, number] => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
    for (const l of sky) {
      if (l.kind !== 'planet' && l.kind !== 'gasGiant' && l.kind !== 'moon') continue;
      const tex = toTex(planetTex(l.kind === 'gasGiant' ? 384 : 256, -0.6, l.seed, tint3(l.tint)));
      addLand(l, tex, 'normal', 1, l.kind === 'gasGiant' ? 0.25 : 0.3);
    }
    tile(T.starNear, 0.18, 0.45, 0.85, [0.22, 0.45, Infinity, Infinity]);
    // Near dust: faint motes between the stars and the world.
    for (let i = 0; i < 60; i++) {
      const s = new Sprite(T.glow); s.anchor.set(0.5); s.blendMode = 'add'; s.tint = 0xcfdcff; this.sky.addChild(s);
      this.nearMotes.push({ s, lx: h01(i, 61), ly: h01(i, 62), size: 2 + 2 * h01(i, 63), alpha: 0.18 + 0.2 * h01(i, 64) });
    }
    // Nebula volumes: slices behind the world (sky) and in front of it (fore).
    for (const g of this.regions) {
      for (const [parallax, front, count] of [[0.6, false, 9], [0.85, false, 9], [1.2, true, 7], [1.5, true, 5]] as const) {
        for (let i = 0; i < count; i++) {
          const a = h01(i, g.seed * 31 + Math.round(parallax * 10)) * Math.PI * 2;
          const d = Math.sqrt(h01(i, g.seed * 17 + Math.round(parallax * 10))) * g.r * 0.85;
          const s = new Sprite(wisp(i + g.seed)); s.anchor.set(0.5);
          s.blendMode = g.variant === 'dark' ? 'normal' : 'add';
          s.tint = REGION_TINT[g.variant]; s.rotation = a * 3;
          (front ? this.fore : this.sky).addChild(s);
          this.wisps.push({ s, wx: g.x + Math.cos(a) * d, wy: g.y + Math.sin(a) * d, parallax, zoomPow: parallax, size: g.r * (front ? 0.55 : 0.8), alpha: front ? 0.16 : 0.22, front, region: g });
        }
      }
    }
    // Fore dust: a few motes nearer than the world, streaming past.
    for (let i = 0; i < 26; i++) {
      const s = new Sprite(T.glow); s.anchor.set(0.5); s.blendMode = 'add'; s.tint = 0xe6eeff; this.fore.addChild(s);
      this.foreMotes.push({ s, lx: h01(i, 71), ly: h01(i, 72), size: 3 + 3 * h01(i, 73), alpha: 0.22 + 0.2 * h01(i, 74) });
    }
    // Colour grade while inside a nebula (a faint full-screen tint).
    this.grade = new Sprite(Texture.WHITE); this.grade.width = W; this.grade.height = H; this.grade.blendMode = 'add'; this.grade.alpha = 0;
    this.fore.addChild(this.grade);
  }

  /** Lay out for a camera at (cx, cy, zoom) moving at (vx, vy) world/s;
   *  `sf` 0..1 is the (eased) speed factor. */
  update(cx: number, cy: number, zoom: number, vx: number, vy: number, sf: number): void {
    const W = this.W, H = this.H;
    const d = nebulaDensityAt(cx, cy, this.regions);
    this.density = d;
    for (const tl of this.tiles) {
      backdropXf(cx, cy, zoom, tl.parallax, tl.zoomPow, W, H, this.xf);
      tl.s.tileScale.set(this.xf.scale); tl.s.tilePosition.set(this.xf.x, this.xf.y);
      tl.s.alpha = tl.alpha * (tl.win ? zoomWindow(zoom, tl.win[0], tl.win[1], tl.win[2], tl.win[3]) : 1) * (tl.star ? 1 - 0.55 * d : 1);
    }
    for (const lv of this.lands) {
      landmarkScreen(lv.l, cx, cy, zoom, lv.zoomPow, W, H, this.lp);
      lv.s.position.set(this.lp.x, this.lp.y);
      lv.s.scale.set((lv.l.size * this.lp.scale) / lv.s.texture.width);
      lv.s.visible = this.lp.x > -lv.l.size && this.lp.x < W + lv.l.size && this.lp.y > -lv.l.size && this.lp.y < H + lv.l.size;
    }
    const hole0 = Math.min(W, H) * 0.16, hole1 = Math.min(W, H) * 0.46;
    for (const w of this.wisps) {
      const s = Math.pow(Math.max(1e-3, zoom), w.zoomPow);
      const x = W / 2 + (w.wx - cx) * w.parallax * s, y = H / 2 + (w.wy - cy) * w.parallax * s;
      const size = w.size * s;
      w.s.visible = x > -size && x < W + size && y > -size && y < H + size;
      if (!w.s.visible) continue;
      w.s.position.set(x, y); w.s.scale.set(size / w.s.texture.width);
      let a = w.alpha;
      if (w.front) {
        // A clear hole round the ship: front wisps fade near the middle.
        const r = Math.hypot(x - W / 2, y - H / 2);
        const k = Math.min(1, Math.max(0, (r - hole0) / (hole1 - hole0)));
        a *= k * k * (3 - 2 * k);
      }
      w.s.alpha = a;
    }
    // Motes: wrapped around the camera; streak along the motion at speed.
    const p = SPEED_FX[this.level];
    const sl = Math.hypot(vx, vy);
    const ang = sl > 1 ? Math.atan2(vy, vx) : 0;
    const motes = (list: Mote[], parallax: number, zoomPow: number, gain: number): void => {
      const s = Math.pow(Math.max(1e-3, zoom), zoomPow);
      const P = (Math.max(W, H) * 1.25) / s;
      for (const m of list) {
        let lx = (m.lx * P - cx * parallax) % P; if (lx < 0) lx += P;
        let ly = (m.ly * P - cy * parallax) % P; if (ly < 0) ly += P;
        m.s.position.set(W / 2 + (lx - P / 2) * s, H / 2 + (ly - P / 2) * s);
        const stretch = 1 + p.stretch * sf * gain;
        m.s.rotation = ang;
        m.s.scale.set((m.size * stretch) / m.s.texture.width, m.size / m.s.texture.height);
        m.s.alpha = Math.min(1, m.alpha * (1 + p.streakGain * sf));
      }
    };
    motes(this.nearMotes, 0.4, 0.7, 0.4);
    motes(this.foreMotes, 1.3, 1.1, 1);
    // Grade: tint the view toward the nebula you're in.
    let tint = 0xffffff;
    for (const g of this.regions) if (Math.hypot(cx - g.x, cy - g.y) < g.r) tint = REGION_TINT[g.variant];
    this.grade.tint = tint; this.grade.alpha = 0.045 * d;
  }
}
