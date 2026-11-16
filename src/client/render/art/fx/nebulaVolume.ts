/**
 * The dense-nebula volume (look R&D, `?neblook=`): part of `Backdrop`, drawn
 * into its existing nebula containers (behind and in front of the world), in
 * place of the C2 wisp regions while the flag is on. Not a second renderer.
 *
 * Depth comes from many layers at different parallax:
 *  - cloud layers behind the world (tiling, additive), far = big and slow,
 *    near = finer and faster, each drifting slowly so the gas feels alive;
 *  - a dark dust layer between them (normal blend: it hides what's behind);
 *  - glowing star knots inside the cloud (a halo lighting the gas round a
 *    bright core);
 *  - lightning: brief flickering glows deep in the cloud;
 *  - cloud puffs in front of the world, faded round the screen centre so
 *    they never hide your ship.
 *
 * Per frame: scalar writes on pooled sprites only (invariant #14).
 */
import { Container, Sprite, TilingSprite, type Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { backdropXf, type TileXf } from './fxMath.js';
import { h01 } from './fxTextures.js';
import { hueTint, type NebulaStyle } from './nebulaLook.js';

interface Layer { rot: number; s: TilingSprite; h: ArtHandle; parallax: number; zoomPow: number; texScale: number; alpha: number; dvx: number; dvy: number; order: number }
interface Puff { s: Sprite; slice: number; lx: number; ly: number; size: number; rot: number }
interface Knot { halo: Sprite; core: Sprite; lx: number; ly: number; size: number }

/** Front puff slices: parallax (and zoom growth). */
const FRONT = [1.18, 1.45, 1.8];
const PUFFS_PER_SLICE = 6;
const PUFF_VARIANTS = 4;
const FLASHES = 2;

function ready(h: ArtHandle | null): Texture | null {
  return h && h.state === 'ready' && h.fx ? h.fx.tex : null;
}

function wrap(v: number, p: number): number {
  const r = v % p;
  return r < 0 ? r + p : r;
}

export class NebulaVolume {
  private readonly layers: Layer[] = [];
  private readonly puffs: Puff[] = [];
  private readonly puffHandles: ArtHandle[] = [];
  private readonly knots: Knot[] = [];
  private readonly flashes: Sprite[] = [];
  private readonly glow: ArtHandle;
  private readonly spike: ArtHandle;
  private readonly xf: TileXf = { x: 0, y: 0, scale: 1 };
  /** Grade tint for the full-screen colour wash. */
  readonly gradeTint: number;

  constructor(art: ArtService, readonly style: NebulaStyle, back: Container, front: Container) {
    const look = `${style.preset}:${style.seed}`;
    const L = style.layers;
    this.glow = art.fx('glow', undefined, undefined, false);
    this.spike = art.fx('spikeStar', undefined, undefined, false);
    this.gradeTint = hueTint(style.hueA, 0.55);
    const dustAt = Math.floor(L * 0.6);
    for (let li = 0; li < L; li++) {
      const f = L > 1 ? li / (L - 1) : 0;
      const p = 0.22 + 0.66 * f;
      const a = h01(li, style.seed * 13 + 3) * Math.PI * 2;
      const speed = 3 + 7 * f;
      this.layers.push(this.makeLayer(art, `${look}.L${li}`, back, 'add', p, 0.3 + 0.6 * f, 4.2 - 2.2 * f,
        (0.3 + 0.25 * f) * (0.7 + 0.3 * style.thickness), Math.cos(a) * speed, Math.sin(a) * speed, li));
      if (li === dustAt && style.dust > 0.05) {
        // Dust sits between the layers, nearer than most of the glow.
        this.layers.push(this.makeLayer(art, `${look}.D`, back, 'normal', p + 0.04, 0.32 + 0.6 * f, 3.4, 0.95 * style.dust, -Math.cos(a) * 2, -Math.sin(a) * 2, -1));
      }
    }
    // Knots and flashes sit over the far layers (they light the gas).
    for (let k = 0; k < style.knots; k++) {
      const halo = new Sprite(); halo.anchor.set(0.5); halo.blendMode = 'add'; halo.visible = false;
      const core = new Sprite(); core.anchor.set(0.5); core.blendMode = 'add'; core.visible = false;
      const hue = h01(k, style.seed * 29 + 1) < 0.5 ? style.hueA : style.hueB;
      halo.tint = hueTint(hue + style.rainbow * h01(k, style.seed + 77), 0.6);
      core.tint = hueTint(hue, 0.15);
      back.addChild(halo); back.addChild(core);
      this.knots.push({ halo, core, lx: h01(k, style.seed * 5 + 11), ly: h01(k, style.seed * 5 + 12), size: 0.5 + h01(k, style.seed * 5 + 13) });
    }
    for (let j = 0; j < FLASHES; j++) {
      const s = new Sprite(); s.anchor.set(0.5); s.blendMode = 'add'; s.visible = false;
      s.tint = hueTint(style.hueB, 0.25);
      back.addChild(s);
      this.flashes.push(s);
    }
    for (let v = 0; v < PUFF_VARIANTS; v++) this.puffHandles.push(art.fx('nebPuff', `${look}.P${v}`, undefined, false));
    for (let si = 0; si < style.frontSlices; si++) {
      for (let i = 0; i < PUFFS_PER_SLICE; i++) {
        const s = new Sprite(); s.anchor.set(0.5); s.blendMode = 'add'; s.visible = false;
        front.addChild(s);
        const k = si * 31 + i;
        this.puffs.push({ s, slice: si, lx: h01(k, style.seed + 401), ly: h01(k, style.seed + 402), size: 0.55 + 0.6 * h01(k, style.seed + 403), rot: h01(k, style.seed + 404) * Math.PI * 2 });
      }
    }
  }

  private makeLayer(art: ArtService, variant: string, parent: Container, blend: 'add' | 'normal', parallax: number,
    zoomPow: number, texScale: number, alpha: number, dvx: number, dvy: number, order: number): Layer {
    const s = new TilingSprite({ width: 1, height: 1 });
    s.blendMode = blend; s.visible = false;
    parent.addChild(s);
    return { rot: (order + 1) * 0.9, s, h: art.fx('nebLayer', variant, undefined, false), parallax, zoomPow, texScale, alpha, dvx, dvy, order };
  }

  /** Draw for a camera at Pixi-space (cx, cy). `t` is effects time (s). */
  update(cx: number, cy: number, zoom: number, W: number, H: number, t: number, q: string): void {
    const st = this.style;
    const L = st.layers;
    const maxLayers = q === 'high' ? L : q === 'medium' ? Math.max(2, L - 2) : q === 'low' ? 2 : 1;
    // Keep the nearest glow layers when dropping (they carry the depth cue).
    const firstOn = L - maxLayers;
    for (let i = 0; i < this.layers.length; i++) {
      const l = this.layers[i]!;
      const tex = ready(l.h);
      const on = l.order < 0 ? q !== 'minimal' : l.order >= firstOn;
      if (!tex || !on) { l.s.visible = false; continue; }
      if (l.s.texture !== tex) l.s.texture = tex;
      l.s.visible = true;
      if (l.s.width !== W) l.s.width = W;
      if (l.s.height !== H) l.s.height = H;
      backdropXf(cx, cy, zoom, l.parallax, l.zoomPow, W, H, this.xf);
      const ts = this.xf.scale * l.texScale;
      l.s.tileScale.set(ts);
      l.s.tileRotation = l.rot;
      l.s.tilePosition.set(wrap(this.xf.x + l.dvx * t * ts, tex.width * ts), wrap(this.xf.y + l.dvy * t * ts, tex.height * ts));
      l.s.alpha = l.alpha;
    }
    // Knots: wrap round the camera at mid depth.
    const glow = ready(this.glow), spike = ready(this.spike);
    const kn = q === 'low' || q === 'minimal' ? this.knots.length >> 1 : this.knots.length;
    const ks = Math.pow(Math.max(1e-3, zoom), 0.5);
    const KP = (Math.max(W, H) * 1.6) / ks;
    for (let k = 0; k < this.knots.length; k++) {
      const n = this.knots[k]!;
      const on = k < kn && glow !== null && spike !== null;
      n.halo.visible = on; n.core.visible = on;
      if (!on) continue;
      const x = W / 2 + (wrap(n.lx * KP - cx * 0.5, KP) - KP / 2) * ks;
      const y = H / 2 + (wrap(n.ly * KP - cy * 0.5, KP) - KP / 2) * ks;
      if (n.halo.texture !== glow) n.halo.texture = glow!;
      if (n.core.texture !== spike) n.core.texture = spike!;
      const hs = (180 + 420 * n.size) * ks;
      n.halo.position.set(x, y); n.halo.scale.set(hs / glow!.width);
      n.halo.alpha = 0.32 + 0.08 * Math.sin(t * (0.7 + k * 0.13) + k);
      n.core.position.set(x, y); n.core.scale.set(((14 + 22 * n.size) * Math.max(0.6, ks)) / spike!.width);
      n.core.alpha = 0.85 + 0.15 * Math.sin(t * (2.1 + k * 0.37) + k * 1.7);
    }
    // Lightning: each slot flashes at a seeded rhythm, flickering a few times.
    const rate = st.lightning;
    for (let j = 0; j < this.flashes.length; j++) {
      const s = this.flashes[j]!;
      if (!(rate > 0) || !glow || q === 'minimal') { s.visible = false; continue; }
      const period = (60 / rate) * this.flashes.length;
      const ph = t + h01(j, st.seed + 900) * period;
      const n = Math.floor(ph / period);
      const local = ph - n * period - h01(n, st.seed + 901 + j) * period * 0.5;
      const dur = 0.7;
      if (local < 0 || local > dur) { s.visible = false; continue; }
      const env = Math.sin((local / dur) * Math.PI) * (0.45 + 0.55 * Math.abs(Math.sin(local * 38 + n)));
      if (s.texture !== glow) s.texture = glow;
      s.visible = true;
      s.position.set(W * (0.1 + 0.8 * h01(n, st.seed + 902 + j)), H * (0.1 + 0.8 * h01(n, st.seed + 903 + j)));
      s.scale.set((Math.max(W, H) * (0.5 + 0.5 * h01(n, st.seed + 904))) / glow.width);
      s.alpha = 0.55 * env;
    }
    // Front puffs, faded round the screen centre (where your ship is).
    const slices = q === 'high' ? st.frontSlices : q === 'medium' ? Math.min(1, st.frontSlices) : 0;
    const hole0 = Math.min(W, H) * 0.14, hole1 = Math.min(W, H) * 0.5;
    for (let i = 0; i < this.puffs.length; i++) {
      const pf = this.puffs[i]!;
      const tex = ready(this.puffHandles[i % PUFF_VARIANTS]!);
      if (!tex || pf.slice >= slices) { pf.s.visible = false; continue; }
      const p = FRONT[pf.slice]!;
      const s = Math.pow(Math.max(1e-3, zoom), p * 0.6);
      const P = (Math.max(W, H) * 2.2) / s;
      const x = W / 2 + (wrap(pf.lx * P - cx * p, P) - P / 2) * s;
      const y = H / 2 + (wrap(pf.ly * P - cy * p, P) - P / 2) * s;
      const size = Math.max(W, H) * pf.size;
      if (x < -size || x > W + size || y < -size || y > H + size) { pf.s.visible = false; continue; }
      if (pf.s.texture !== tex) pf.s.texture = tex;
      pf.s.visible = true;
      pf.s.position.set(x, y); pf.s.scale.set(size / tex.width); pf.s.rotation = pf.rot + t * 0.01 * (pf.slice + 1);
      const rr = Math.hypot(x - W / 2, y - H / 2);
      const k = Math.min(1, Math.max(0, (rr - hole0) / (hole1 - hole0)));
      pf.s.alpha = (0.22 + 0.25 * st.thickness) * k * k * (3 - 2 * k);
    }
  }
}
