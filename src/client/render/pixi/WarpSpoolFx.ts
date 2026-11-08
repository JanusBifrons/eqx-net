/**
 * Warp spool-up: the engines overcharge (2026-11-08). The user: the old
 * spool "looks a bit lame, especially when zoomed in"; of two concepts
 * filmed, they picked this one. It must work on every ship (fighters to
 * capitals) and for any spool length ("it won't always be 3s").
 *
 * Every real nozzle swells and shifts from blue to white-hot, flickering
 * harder as the charge builds; sparks leak out astern; a flare over the last
 * part of the charge. Driven by the charge PROGRESS (0..1), never by
 * seconds, so a 3 s in-system spool and a 30 s sector spool both build
 * fully. Sizes come from the ship's own nozzles, with an on-screen floor.
 * Pooled per ship; per frame only scalar writes (#14).
 */
import { Container, Graphics, Sprite, Texture } from 'pixi.js';

/** Tunables (one place, so the look can be dialled without touching code). */
export const SPOOL_FX = {
  /** Nozzle glow radius, × nozzle r, at no charge and full charge. */
  glowR0: 2, glowR1: 5,
  /** Sparks per nozzle (pooled), their reach (× hull half length), life (s). */
  sparksPerNozzle: 7, sparkReach: 1.4, sparkLife: 0.5,
  /** The flare over the last part of the charge (progress where it starts). */
  flareFrom: 0.88,
} as const;

const COLD = 0x7fc4ff, HOT = 0xfff4e0, SPARK = 0xffd7a0;

export interface Nozzle { x: number; y: number; r: number }

export interface SpoolFxShip {
  /** Sprite pose (Pixi space). */
  x: number; y: number; rotation: number;
  /** Charge progress 0..1 while spooling; -1 when not spooling. */
  progress: number;
  /** Nozzles in ship-local Pixi units (nose toward -y). */
  nozzles: readonly Nozzle[];
  /** Hull half length along the nose (world u): how far sparks reach. */
  half: number;
}

function softDot(): Graphics {
  // White, so the per-frame tint alone sets the colour; many faint rings
  // falling off towards the edge give a smooth glow with no bands.
  const g = new Graphics();
  for (let i = 16; i >= 1; i--) g.circle(0, 0, i / 16).fill({ color: 0xffffff, alpha: 0.06 + 0.02 * (1 - i / 16) });
  g.blendMode = 'add';
  return g;
}
function bar(color: number): Sprite {
  const s = new Sprite(Texture.WHITE);
  s.anchor.set(0.5, 0.5);
  s.tint = color;
  s.blendMode = 'add';
  return s;
}
/** Linear blend of two 0xRRGGBB colours. */
export function mixColor(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, t));
  const r = ((a >> 16) & 255) + ((((b >> 16) & 255) - ((a >> 16) & 255)) * k);
  const g = ((a >> 8) & 255) + ((((b >> 8) & 255) - ((a >> 8) & 255)) * k);
  const bl = (a & 255) + (((b & 255) - (a & 255)) * k);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

interface NozzleView { glow: Graphics; core: Graphics; sparks: Sprite[]; seed: number[] }
interface View { gen: number; nozzles: NozzleView[]; t0: number }

export class WarpSpoolFx {
  /** Under the hulls: engine glow and sparks. */
  readonly layer = new Container();
  private readonly views = new Map<string, View>();
  private gen = 0;
  private now = 0;
  private px = 1;
  /** Spooling ships drawn this frame (stats / tests). */
  spooling = 0;

  constructor() {
    this.layer.eventMode = 'none';
  }

  beginFrame(nowMs: number, worldScale: number): void {
    this.gen++;
    this.spooling = 0;
    this.now = nowMs / 1000;
    this.px = worldScale > 0 ? 1 / worldScale : 1;
  }

  draw(id: string, s: SpoolFxShip): void {
    let v = this.views.get(id);
    if (s.progress < 0) { if (v) { v.gen = this.gen; v.t0 = -1; this.hide(v); } return; }
    if (!v) { v = { gen: 0, nozzles: [], t0: -1 }; this.views.set(id, v); }
    v.gen = this.gen;
    this.spooling++;
    if (v.t0 < 0) v.t0 = this.now;
    const p = s.progress, px = this.px, t = this.now - v.t0;
    while (v.nozzles.length < s.nozzles.length) v.nozzles.push(this.makeNozzle());
    const c = Math.cos(s.rotation), sn = Math.sin(s.rotation);
    const ax = -sn, ay = c; // astern (Pixi): the nose is local -y
    // Flicker gets harder and faster as the charge builds; a flare at the end.
    const flare = Math.max(0, (p - SPOOL_FX.flareFrom) / (1 - SPOOL_FX.flareFrom));
    const color = mixColor(COLD, HOT, p * p);
    for (let n = 0; n < v.nozzles.length; n++) {
      const nv = v.nozzles[n]!;
      const nz = s.nozzles[n];
      if (!nz) { this.hideNozzle(nv); continue; }
      const x = s.x + nz.x * c - nz.y * sn, y = s.y + nz.x * sn + nz.y * c;
      const flick = 1 + (0.06 + 0.3 * p) * Math.sin(t * (18 + 40 * p) + n * 1.7) * Math.sin(t * (11 + 23 * p) + n);
      const r = Math.max(nz.r * (SPOOL_FX.glowR0 + (SPOOL_FX.glowR1 - SPOOL_FX.glowR0) * p), px * (3 + 6 * p)) * flick * (1 + 0.6 * flare);
      place(nv.glow, x, y, r, Math.min(0.8, (0.25 + 0.45 * p) * (1 + 0.4 * flare)), color);
      place(nv.core, x, y, r * 0.3, Math.min(0.9, 0.4 + 0.5 * p + flare), HOT);
      // Sparks: each loops from the nozzle astern, staggered; more show as it charges.
      const live = Math.ceil(nv.sparks.length * Math.min(1, 0.15 + p));
      const reach = Math.max(s.half * SPOOL_FX.sparkReach, px * 30) * (0.5 + 0.5 * p);
      for (let k = 0; k < nv.sparks.length; k++) {
        const sp = nv.sparks[k]!;
        if (k >= live) { sp.visible = false; continue; }
        const life = SPOOL_FX.sparkLife * (0.7 + 0.6 * nv.seed[k]!);
        const u = ((t + nv.seed[k]! * life) % life) / life;
        const side = (nv.seed[(k + 1) % nv.seed.length]! - 0.5) * nz.r * 2.2;
        const d = reach * u;
        sp.visible = true;
        sp.position.set(x + ax * d - ay * side * u, y + ay * d + ax * side * u);
        sp.rotation = Math.atan2(ay, ax);
        sp.scale.set(Math.max(nz.r * 1.6, px * 8) * (1 - u * 0.5), Math.max(nz.r * 0.2, px * 1.6));
        sp.alpha = (1 - u) * (0.6 + 0.4 * p);
      }
    }
  }

  endFrame(): void {
    for (const [id, v] of this.views) {
      if (v.gen === this.gen) continue;
      this.free(v);
      this.views.delete(id);
    }
  }

  private makeNozzle(): NozzleView {
    const glow = softDot(), core = softDot();
    glow.visible = core.visible = false;
    this.layer.addChild(glow, core);
    const sparks: Sprite[] = [], seed: number[] = [];
    for (let k = 0; k < SPOOL_FX.sparksPerNozzle; k++) {
      const b = bar(SPARK); b.visible = false; this.layer.addChild(b); sparks.push(b);
      seed.push((k * 0.618034 + 0.137) % 1);
    }
    return { glow, core, sparks, seed };
  }
  private hideNozzle(nv: NozzleView): void {
    nv.glow.visible = nv.core.visible = false;
    for (const sp of nv.sparks) sp.visible = false;
  }
  private hide(v: View): void { for (const nv of v.nozzles) this.hideNozzle(nv); }
  private free(v: View): void {
    for (const nv of v.nozzles) { nv.glow.destroy(); nv.core.destroy(); for (const sp of nv.sparks) sp.destroy(); }
  }
}

function place(g: Graphics, x: number, y: number, r: number, alpha: number, tint: number): void {
  g.visible = alpha > 0.01;
  g.x = x; g.y = y;
  g.scale.set(r);
  g.alpha = Math.min(1, alpha);
  g.tint = tint;
}
