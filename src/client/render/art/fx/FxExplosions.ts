/**
 * New explosions and missile smoke (plan iridescent-seeking-rainbow v3, B4).
 *
 * `FxExplosions` plays a pooled burst: a white flash, the baked fireball
 * flipbook, secondary fireballs on big blasts, a shock ring, embers that fly
 * out and cool, and dark smoke that lingers. One size parameter (the blast
 * radius) scales it from a missile pop to a structure going up.
 *
 * `FxMissileTrails` gives each missile a smoke ribbon (a rope mesh fed by a
 * fixed history of its positions) and a hot exhaust glow.
 *
 * Textures come from `ArtService.fx`; nothing draws until they're ready (the
 * caller keeps today's effect). Pooled; per frame only scalar writes on
 * pooled sprites (invariant #14). Inputs are GAME space (Y up).
 */
import { Container, MeshRope, Point, Sprite, type Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { emberTint, envelope, flipFrame, TrailRing } from './fxMath.js';

const tex = (h: ArtHandle): Texture | null => (h.state === 'ready' && h.fx ? h.fx.tex : null);

const EMBERS = 16;
const SMOKE = 6;
const SUBS = 3;
/** Longest anything in a burst lives (the smoke), seconds. */
const BURST_LIFE_S = 3.4;
const MAX_BURSTS = 24;

interface Burst {
  active: boolean; x: number; y: number; r: number; t0: number; seed: number;
  flash: Sprite; fire: Sprite; subs: Sprite[]; ring: Sprite; embers: Sprite[]; smoke: Sprite[];
}

/** Blast radius for a dying entity whose sprite is `diameter` world units across. */
export function blastRadiusFor(diameter: number): number {
  return Math.max(34, Math.min(280, diameter * 1.1));
}

/** Fireball play time for a blast of radius `r` (bigger blasts burn longer). */
export function fireballLife(r: number): number {
  return 0.55 + Math.min(0.9, r / 300);
}

export class FxExplosions {
  /** Additive fire, ring, embers. */
  readonly fireLayer = new Container();
  /** Normal-blend smoke (under the fire). */
  readonly smokeLayer = new Container();
  private readonly bursts: Burst[] = [];
  private readonly fire: ArtHandle;
  private readonly glow: ArtHandle;
  private readonly ring: ArtHandle;
  private readonly spark: ArtHandle;
  private readonly smoke: ArtHandle;
  private seq = 0;

  constructor(art: ArtService, private readonly getQuality: () => string) {
    this.fireLayer.blendMode = 'add';
    this.fireLayer.eventMode = 'none';
    this.smokeLayer.eventMode = 'none';
    this.fire = art.fx('fireball', undefined, undefined, false);
    this.glow = art.fx('glow', undefined, undefined, false);
    this.ring = art.fx('ring', undefined, undefined, false);
    this.spark = art.fx('spark', undefined, undefined, false);
    this.smoke = art.fx('smoke', undefined, undefined, false);
  }

  ready(): boolean {
    return !!(this.fire.fx && this.fire.state === 'ready' && tex(this.glow) && tex(this.ring) && tex(this.spark) && tex(this.smoke));
  }

  /** Start a blast of radius `r` at game-space (x, y). False if not ready. */
  spawn(x: number, y: number, r: number, nowMs: number): boolean {
    if (!this.ready()) return false;
    let b: Burst | undefined;
    for (const c of this.bursts) if (!c.active) { b = c; break; }
    if (!b) {
      if (this.bursts.length < MAX_BURSTS) { b = this.make(); this.bursts.push(b); }
      else { b = this.bursts[0]!; for (const c of this.bursts) if (c.t0 < b.t0) b = c; }
    }
    b.active = true; b.x = x; b.y = -y; b.r = r; b.t0 = nowMs / 1000; b.seed = (this.seq++ * 2.399) % 6.283;
    return true;
  }

  /** Advance every live burst. */
  tick(nowMs: number): void {
    if (!this.ready()) return;
    const t = nowMs / 1000;
    const q = this.getQuality();
    const smokeOn = q === 'high' || q === 'medium';
    const embersN = q === 'high' ? EMBERS : q === 'medium' ? 10 : 6;
    const frames = this.fire.fx!.frames;
    for (const b of this.bursts) {
      if (!b.active) continue;
      const age = t - b.t0;
      if (age >= BURST_LIFE_S || age < 0) { this.hide(b); b.active = false; continue; }
      const R = b.r;
      b.flash.visible = true;
      b.flash.position.set(b.x, b.y); b.flash.scale.set((R * 3.4) / b.flash.texture.width);
      b.flash.alpha = envelope(age, 0.015, 0.3) * 0.6;
      const life = fireballLife(R);
      const fi = flipFrame(age, life, frames.length);
      b.fire.visible = fi >= 0;
      if (fi >= 0) {
        b.fire.texture = frames[fi]!; b.fire.position.set(b.x, b.y);
        b.fire.scale.set((R * 2) / b.fire.texture.width); b.fire.rotation = b.seed; b.fire.alpha = 0.9;
      }
      for (let j = 0; j < SUBS; j++) {
        const s = b.subs[j]!;
        const on = R >= 70;
        const d0 = 0.05 + j * 0.07, a = b.seed * 5 + j * 2.4;
        const sfi = on ? flipFrame(age - d0, life * 0.75, frames.length) : -1;
        s.visible = sfi >= 0;
        if (sfi >= 0) {
          s.texture = frames[sfi]!; s.position.set(b.x + Math.cos(a) * R * 0.55, b.y + Math.sin(a) * R * 0.55);
          s.scale.set((R * 1.15) / s.texture.width); s.rotation = a; s.alpha = 0.7;
        }
      }
      b.ring.visible = age < 0.55;
      if (b.ring.visible) {
        b.ring.position.set(b.x, b.y); b.ring.scale.set((R * 0.35 + age * R * 2.8) / (b.ring.texture.width / 2));
        b.ring.alpha = Math.max(0, 0.6 - age * 1.1);
      }
      for (let j = 0; j < EMBERS; j++) {
        const e = b.embers[j]!;
        const heat = 1 - age / (life * 1.5);
        e.visible = j < embersN && heat > 0;
        if (!e.visible) continue;
        const ed = b.seed * 7 + j * 2.399;
        const spd = (0.7 + ((j * 0.618) % 1)) * R * 2.4;
        const d = (spd * (1 - Math.exp(-age * 2.4))) / 2.4;
        e.position.set(b.x + Math.cos(ed) * d, b.y + Math.sin(ed) * d); e.rotation = ed;
        e.scale.set((5 + spd * Math.exp(-age * 2.4) * 0.045) / e.texture.width, 3.4 / e.texture.height);
        e.tint = emberTint(heat); e.alpha = Math.min(1, heat * 1.4);
      }
      for (let j = 0; j < SMOKE; j++) {
        const s = b.smoke[j]!;
        s.visible = smokeOn && age > 0.1;
        if (!s.visible) continue;
        const a = b.seed * 3 + j * 2.1;
        const d = R * 0.45 * (1 - Math.exp(-age * 1.3)) + age * 6;
        s.position.set(b.x + Math.cos(a) * d, b.y + Math.sin(a) * d);
        s.scale.set((R * 1.1 * (0.7 + age * 0.5)) / s.texture.width); s.rotation = a + age * 0.15;
        s.alpha = 0.55 * envelope(age - 0.12, 0.35, 3.2);
      }
    }
  }

  activeCount(): number {
    let n = 0;
    for (const b of this.bursts) if (b.active) n++;
    return n;
  }

  reset(): void { for (const b of this.bursts) { this.hide(b); b.active = false; } }

  destroy(): void {
    this.fireLayer.destroy({ children: true });
    this.smokeLayer.destroy({ children: true });
  }

  private hide(b: Burst): void {
    b.flash.visible = false; b.fire.visible = false; b.ring.visible = false;
    for (const s of b.subs) s.visible = false;
    for (const s of b.embers) s.visible = false;
    for (const s of b.smoke) s.visible = false;
  }

  private make(): Burst {
    const fireT = this.fire.fx!.frames[0]!, glow = tex(this.glow)!, ring = tex(this.ring)!, spark = tex(this.spark)!, smoke = tex(this.smoke)!;
    const mk = (t: Texture, layer: Container, tint = 0xffffff, ax = 0.5): Sprite => {
      const s = new Sprite(t); s.anchor.set(ax, 0.5); s.tint = tint; s.visible = false; layer.addChild(s); return s;
    };
    const smokeSprites: Sprite[] = [];
    for (let j = 0; j < SMOKE; j++) smokeSprites.push(mk(smoke, this.smokeLayer, 0x2e2a27));
    const subs: Sprite[] = [];
    for (let j = 0; j < SUBS; j++) subs.push(mk(fireT, this.fireLayer));
    const fire = mk(fireT, this.fireLayer);
    const ringS = mk(ring, this.fireLayer, 0xffd6a8);
    const embers: Sprite[] = [];
    for (let j = 0; j < EMBERS; j++) embers.push(mk(spark, this.fireLayer, 0xffffff, 1));
    const flash = mk(glow, this.fireLayer, 0xfff2d8);
    return { active: false, x: 0, y: 0, r: 0, t0: 0, seed: 0, flash, fire, subs, ring: ringS, embers, smoke: smokeSprites };
  }
}

const ROPE_POINTS = 18;
/** Only record a new point once the missile has moved this far (world units). */
const ROPE_STEP = 5;

interface Trail { ring: TrailRing; rope: MeshRope; pts: Point[]; glow: Sprite; gen: number; lastX: number; lastY: number }

export class FxMissileTrails {
  /** Normal-blend smoke ribbons. */
  readonly smokeLayer = new Container();
  /** Additive exhaust glows. */
  readonly glowLayer = new Container();
  private readonly live = new Map<number, Trail>();
  private readonly free: Trail[] = [];
  private readonly trail: ArtHandle;
  private readonly glow: ArtHandle;
  private gen = 0;

  constructor(art: ArtService) {
    this.smokeLayer.eventMode = 'none';
    this.glowLayer.eventMode = 'none';
    this.glowLayer.blendMode = 'add';
    this.trail = art.fx('trail', undefined, undefined, false);
    this.glow = art.fx('glow', undefined, undefined, false);
  }

  ready(): boolean { return tex(this.trail) !== null && tex(this.glow) !== null; }

  beginFrame(): void { this.gen++; }

  /** Missile `id` is at game-space (x, y) heading `angle` (game radians). */
  draw(id: number, x: number, y: number, angle: number, nowMs: number): void {
    let tr = this.live.get(id);
    const px = x, py = -y;
    if (!tr) {
      tr = this.free.pop() ?? this.make();
      tr.ring.reset(px, py);
      tr.lastX = px; tr.lastY = py;
      tr.ring.push(px, py);
      this.live.set(id, tr);
    }
    tr.gen = this.gen;
    if (Math.hypot(px - tr.lastX, py - tr.lastY) >= ROPE_STEP) { tr.ring.push(px, py); tr.lastX = px; tr.lastY = py; }
    // Head point follows the missile exactly; the rest is history.
    tr.pts[0]!.set(px, py);
    for (let k = 1; k < ROPE_POINTS; k++) tr.pts[k]!.set(tr.ring.readX(k - 1), tr.ring.readY(k - 1));
    tr.rope.visible = true; tr.rope.alpha = 0.5;
    // Exhaust glow at the tail: the missile sprite points up (-y) at
    // rotation -angle, so its tail is (0, +5) turned by that rotation.
    tr.glow.visible = true;
    tr.glow.position.set(px + Math.sin(angle) * 5, py + Math.cos(angle) * 5);
    tr.glow.scale.set((22 / tr.glow.texture.width) * (0.85 + 0.15 * Math.sin(nowMs * 0.061 + id)));
  }

  endFrame(): void {
    for (const [id, tr] of this.live) {
      if (tr.gen === this.gen) continue;
      tr.rope.visible = false; tr.glow.visible = false;
      this.live.delete(id);
      this.free.push(tr);
    }
  }

  liveCount(): number { return this.live.size; }

  destroy(): void {
    this.smokeLayer.destroy({ children: true });
    this.glowLayer.destroy({ children: true });
  }

  private make(): Trail {
    const pts: Point[] = [];
    for (let k = 0; k < ROPE_POINTS; k++) pts.push(new Point());
    const rope = new MeshRope({ texture: tex(this.trail)!, points: pts, textureScale: 0 });
    rope.tint = 0xb0a89c; rope.visible = false;
    this.smokeLayer.addChild(rope);
    const glow = new Sprite(tex(this.glow)!);
    glow.anchor.set(0.5); glow.tint = 0xffa050; glow.visible = false;
    this.glowLayer.addChild(glow);
    return { ring: new TrailRing(ROPE_POINTS), rope, pts, glow, gen: -1, lastX: 0, lastY: 0 };
  }
}
