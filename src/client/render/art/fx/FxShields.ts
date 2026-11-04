/**
 * New shields and shield fences (plan iridescent-seeking-rainbow v3, B5).
 *
 * `FxShields`: a ship's shield is invisible at rest. A hit plays the baked
 * hit flipbook turned to face where it landed; a laser on the shield is a
 * held contact (`ShieldContacts`: one steady lit patch per beam, close beams
 * share one); the shield going down plays a flash and shards.
 *
 * `FxFences`: a fence at rest is a thin flowing energy line (the `fenceStrip`
 * flipbook drawn as short batched segments) with glowing posts. It grows from
 * both posts when raised, flickers out when it loses power (the posts then
 * spark), and a gate's span pulls back into its posts when it opens.
 *
 * Textures come from `ArtService.fx`; until they're ready the callers keep
 * today's ring and rails. Pooled; per frame only scalar writes on pooled
 * sprites (invariant #14). Inputs are GAME space (Y up) unless noted.
 */
import { Container, Sprite, type Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { emberTint, envelope, flipFrame, ShieldContacts, ShieldHits, SHIELD_CONTACTS, SHIELD_HITS } from './fxMath.js';
import { h01 } from './fxTextures.js';

const tex = (h: ArtHandle): Texture | null => (h.state === 'ready' && h.fx ? h.fx.tex : null);

const HIT_LIFE = 0.5;
const BREAK_LIFE = 0.8;
const SHARDS = 10;

interface ShieldView {
  id: string; r: number; x: number; y: number; up: boolean; tracked: boolean; breakT: number; gen: number;
  hits: ShieldHits; contacts: ShieldContacts;
  hitSprites: Sprite[]; held: Sprite[]; ripples: Sprite[]; dome: Sprite; shards: Sprite[];
}

/** Pixi-space pose of an entity (its sprite), or false if it has none. */
export type ShieldPoseFn = (id: string, out: { x: number; y: number }) => boolean;

export class FxShields {
  readonly container = new Container();
  private readonly views = new Map<string, ShieldView>();
  private readonly free: ShieldView[] = [];
  private readonly hit: ArtHandle;
  private readonly contact: ArtHandle;
  private readonly dome: ArtHandle;
  private readonly spark: ArtHandle;
  private readonly pose = { x: 0, y: 0 };
  private gen = 0;
  private lastMs = 0;

  constructor(art: ArtService, private readonly tint = 0x7fd8ff) {
    this.container.blendMode = 'add';
    this.container.eventMode = 'none';
    this.hit = art.fx('shieldHit', undefined, undefined, false);
    this.contact = art.fx('shieldContact', undefined, undefined, false);
    this.dome = art.fx('shieldDome', undefined, undefined, false);
    this.spark = art.fx('spark', undefined, undefined, false);
  }

  ready(): boolean { return !!(this.hit.fx && this.hit.state === 'ready' && tex(this.contact) && tex(this.dome) && tex(this.spark)); }

  /** Entity `id` has its shield up (radius `r`, world units). Call every
   *  frame for every shielded entity, between `begin` and `end`. */
  shield(id: string, r: number): void {
    let v = this.views.get(id);
    if (!v) { v = this.free.pop() ?? this.make(); v.id = id; v.hits.clear(); v.contacts.clear(); v.breakT = -1; this.views.set(id, v); }
    v.r = r; v.up = true; v.tracked = true; v.gen = this.gen;
  }

  /** A shield-layer hit on `id` at game-space (hx, hy). */
  hitAt(id: string, hx: number, hy: number, nowMs: number, getPose: ShieldPoseFn): void {
    const v = this.views.get(id);
    if (!v || !v.up || !getPose(id, this.pose)) return;
    v.hits.add(Math.atan2(-hy - this.pose.y, hx - this.pose.x), nowMs / 1000, 1);
  }

  /** Beam `key` is resting on `id`'s shield, ending at game-space (ex, ey). */
  beam(id: string, key: number, ex: number, ey: number, getPose: ShieldPoseFn): void {
    const v = this.views.get(id);
    if (!v || !v.up || !getPose(id, this.pose)) return;
    v.contacts.offer(key, Math.atan2(-ey - this.pose.y, ex - this.pose.x), 1);
  }

  begin(): void {
    this.gen++;
    for (const v of this.views.values()) v.contacts.begin();
  }

  /** Lay out every shield; a shield not reported this frame went down (it
   *  plays its break, then frees). */
  end(nowMs: number, getPose: ShieldPoseFn): void {
    const dt = this.lastMs > 0 ? Math.min(0.1, Math.max(0, (nowMs - this.lastMs) / 1000)) : 0;
    this.lastMs = nowMs;
    const t = nowMs / 1000;
    const hitFrames = this.hit.fx!.frames;
    const cellR = (hitFrames[0]!.width / 2) * 0.94;
    for (const [id, v] of this.views) {
      if (v.gen !== this.gen && v.up) { v.up = false; v.breakT = t; }
      v.contacts.end(dt);
      const has = getPose(id, this.pose);
      if (has) { v.x = this.pose.x; v.y = this.pose.y; }
      const ba = v.breakT >= 0 ? t - v.breakT : -1;
      if (!v.up && (ba < 0 || ba >= BREAK_LIFE || !has)) { this.hideView(v); this.views.delete(id); this.free.push(v); continue; }
      const sc = v.r / cellR;
      for (let k = 0; k < SHIELD_HITS; k++) {
        const s = v.hitSprites[k]!;
        const fi = v.up ? flipFrame(v.hits.age(k, t), HIT_LIFE, hitFrames.length) : -1;
        s.visible = fi >= 0;
        if (fi < 0) continue;
        s.texture = hitFrames[fi]!; s.position.set(v.x, v.y); s.rotation = v.hits.ang[k]!; s.scale.set(sc); s.alpha = Math.min(1, v.hits.power[k]!);
      }
      for (let k = 0; k < SHIELD_CONTACTS; k++) {
        const I = v.up ? v.contacts.intensity(k) : 0;
        const h = v.held[k]!, rp = v.ripples[k]!;
        h.visible = I > 0; rp.visible = false;
        if (I <= 0) continue;
        const a = v.contacts.ang[k]!;
        h.position.set(v.x, v.y); h.rotation = a + 0.025 * Math.sin(t * 5 + k * 2); h.scale.set(sc);
        h.alpha = Math.min(1.25, I * (0.82 + 0.18 * Math.sin(t * 11 + k * 1.7) * Math.sin(t * 4.3 + k)));
        const rf = flipFrame(v.contacts.held[k]! % 0.6, HIT_LIFE, hitFrames.length);
        rp.visible = rf >= 0;
        if (rf >= 0) { rp.texture = hitFrames[rf]!; rp.position.set(v.x, v.y); rp.rotation = a; rp.scale.set(sc); rp.alpha = Math.min(1, I) * 0.4; }
      }
      // Break: the dome flares, shards fly off.
      v.dome.visible = ba >= 0 && ba < BREAK_LIFE;
      if (v.dome.visible) {
        v.dome.position.set(v.x, v.y);
        v.dome.scale.set((v.r / ((v.dome.texture.width / 2) * 0.94)) * (1 + ba * 0.5));
        v.dome.alpha = envelope(ba, 0.03, 0.55) * 0.95;
      }
      for (let k = 0; k < SHARDS; k++) {
        const s = v.shards[k]!;
        s.visible = ba >= 0 && ba < BREAK_LIFE;
        if (!s.visible) continue;
        const a = k * 2.399, spd = 120 + ((k * 0.53) % 1) * 160;
        const d = v.r + (spd * (1 - Math.exp(-ba * 3))) / 3;
        s.position.set(v.x + Math.cos(a) * d, v.y + Math.sin(a) * d); s.rotation = a;
        s.scale.set(14 / s.texture.width, 3.2 / s.texture.height); s.alpha = 1 - ba / BREAK_LIFE;
      }
    }
  }

  /** Shields drawn (up or breaking). */
  count(): number { return this.views.size; }

  reset(): void { for (const v of this.views.values()) { this.hideView(v); this.free.push(v); } this.views.clear(); }

  destroy(): void { this.container.destroy({ children: true }); }

  private hideView(v: ShieldView): void {
    for (const s of v.hitSprites) s.visible = false;
    for (const s of v.held) s.visible = false;
    for (const s of v.ripples) s.visible = false;
    for (const s of v.shards) s.visible = false;
    v.dome.visible = false;
  }

  private make(): ShieldView {
    const hit0 = this.hit.fx!.frames[0]!, contact = tex(this.contact)!, dome = tex(this.dome)!, spark = tex(this.spark)!;
    const mk = (t: Texture, tint: number, ax = 0.5): Sprite => { const s = new Sprite(t); s.anchor.set(ax, 0.5); s.tint = tint; s.visible = false; this.container.addChild(s); return s; };
    const hot = 0xc8f2ff;
    const hitSprites: Sprite[] = [], held: Sprite[] = [], ripples: Sprite[] = [], shards: Sprite[] = [];
    for (let k = 0; k < SHIELD_HITS; k++) hitSprites.push(mk(hit0, this.tint));
    for (let k = 0; k < SHIELD_CONTACTS; k++) { held.push(mk(contact, hot)); ripples.push(mk(hit0, this.tint)); }
    for (let k = 0; k < SHARDS; k++) shards.push(mk(spark, this.tint, 1));
    return {
      id: '', r: 30, x: 0, y: 0, up: false, tracked: false, breakT: -1, gen: -1,
      hits: new ShieldHits(), contacts: new ShieldContacts(), hitSprites, held, ripples, dome: mk(dome, this.tint), shards,
    };
  }
}

// ------------------------------------------------------------------ fences

/** Fence band thickness and segment length, world units. */
const FENCE_BAND = 24;
const FENCE_SEG = 42;
const RAISE_S = 0.45;
const FALL_S = 0.3;

const FENCE_HITS = 4;
const FENCE_HIT_LIFE = 0.45;
/** Contact "angle" units: 100 world units along the wall. */
const FENCE_POS_UNIT = 100;
const MAX_PENDING_BEAMS = 16;

interface FenceView {
  key: number; gen: number; len: number;
  hitPos: Float32Array; hitT: Float32Array; hitNext: number;
  contacts: ShieldContacts; ripples: Sprite[]; held: Sprite[];
  ax: number; ay: number; bx: number; by: number;
  state: 0 | 1 | 2; // 0 down, 1 up, 2 open gate
  changedAt: number; prevState: 0 | 1 | 2;
  segs: Sprite[]; posts: Sprite[]; sparks: Sprite[];
}

export class FxFences {
  readonly container = new Container();
  private readonly views = new Map<number, FenceView>();
  private readonly free: FenceView[] = [];
  private readonly strip: ArtHandle;
  private readonly glow: ArtHandle;
  private readonly spark: ArtHandle;
  private readonly ripple: ArtHandle;
  private readonly contact: ArtHandle;
  private gen = 0;
  private lastMs = 0;
  /** Fence hits played so far (diagnostics / E2E). */
  hitCount = 0;
  /** Beams resting on fences, buffered until the next layout (the fence
   *  frame runs before the beams are drawn). */
  private readonly pendKey = new Int32Array(MAX_PENDING_BEAMS);
  private readonly pendX = new Float32Array(MAX_PENDING_BEAMS);
  private readonly pendY = new Float32Array(MAX_PENDING_BEAMS);
  private pendN = 0;

  constructor(art: ArtService, private readonly tint = 0x7fd8ff) {
    this.container.blendMode = 'add';
    this.container.eventMode = 'none';
    this.ripple = art.fx('fenceRipple', undefined, undefined, false);
    this.contact = art.fx('fenceContact', undefined, undefined, false);
    this.strip = art.fx('fenceStrip', undefined, undefined, false);
    this.glow = art.fx('glow', undefined, undefined, false);
    this.spark = art.fx('spark', undefined, undefined, false);
  }

  ready(): boolean {
    return !!(this.strip.fx && this.strip.state === 'ready' && this.ripple.fx && this.ripple.state === 'ready'
      && tex(this.contact) && tex(this.glow) && tex(this.spark));
  }

  begin(): void {
    this.gen++;
    for (const v of this.views.values()) v.contacts.begin();
  }

  /** A fence stopped a bolt or missile at game-space (x, y): ripple on the
   *  nearest blocking wall. False if no fence is there (or not ready). */
  hitAt(x: number, y: number, nowMs: number): boolean {
    if (!this.ready()) return false;
    const v = this.nearestWall(x, -y);
    if (!v) return false;
    v.hitPos[v.hitNext] = this.along;
    v.hitT[v.hitNext] = nowMs / 1000;
    v.hitNext = (v.hitNext + 1) % FENCE_HITS;
    this.hitCount++;
    return true;
  }

  /** Beam `key` ends on a fence at game-space (x, y) this frame. */
  beam(key: number, x: number, y: number): void {
    if (this.pendN >= MAX_PENDING_BEAMS) return;
    this.pendKey[this.pendN] = key; this.pendX[this.pendN] = x; this.pendY[this.pendN] = -y;
    this.pendN++;
  }

  /** Beams currently held on fences. */
  contactCount(): number {
    let n = 0;
    for (const v of this.views.values()) n += v.contacts.count();
    return n;
  }

  /** Scratch from `nearestWall`: position along the wall, 0..1. */
  private along = 0;
  private nearestWall(px: number, py: number): FenceView | null {
    let best: FenceView | null = null, bestD = FENCE_BAND * 1.5;
    for (const v of this.views.values()) {
      if (v.state !== 1) continue;
      const dx = v.bx - v.ax, dy = v.by - v.ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.min(1, Math.max(0, ((px - v.ax) * dx + (py - v.ay) * dy) / l2));
      const d = Math.hypot(px - (v.ax + dx * t), py - (v.ay + dy * t));
      if (d < bestD) { bestD = d; best = v; this.along = t; }
    }
    return best;
  }

  /**
   * One derived wall this frame (the same visitor arguments
   * `visitDerivedWalls` passes; game space). `blocking`: up. `open`: an open
   * gate span (or unsealed iris).
   */
  wall(key: number, ax: number, ay: number, bx: number, by: number, blocking: boolean, open: boolean, nowMs: number): void {
    let v = this.views.get(key);
    const state: 0 | 1 | 2 = blocking ? 1 : open ? 2 : 0;
    const t = nowMs / 1000;
    if (!v) {
      v = this.free.pop() ?? this.make();
      v.key = key; v.state = state; v.prevState = state; v.changedAt = -1e9; // first sight: no animation
      this.views.set(key, v);
    } else if (v.state !== state) {
      v.prevState = v.state; v.state = state; v.changedAt = t;
    }
    v.gen = this.gen;
    v.ax = ax; v.ay = -ay; v.bx = bx; v.by = -by;
  }

  end(nowMs: number): void {
    const t = nowMs / 1000;
    const dt = this.lastMs > 0 ? Math.min(0.1, Math.max(0, (nowMs - this.lastMs) / 1000)) : 0;
    this.lastMs = nowMs;
    // Beams that rested on a fence last frame.
    for (let i = 0; i < this.pendN; i++) {
      const v = this.nearestWall(this.pendX[i]!, this.pendY[i]!);
      if (v) v.contacts.offer(this.pendKey[i]!, (this.along * v.len) / FENCE_POS_UNIT, 1);
    }
    this.pendN = 0;
    const rippleFrames = this.ripple.fx!.frames;
    const contactTex = tex(this.contact)!;
    const frames = this.strip.fx!.frames;
    const frame = frames[Math.floor(t * 10) % frames.length]!;
    for (const [key, v] of this.views) {
      if (v.gen !== this.gen) { this.hideView(v); this.views.delete(key); this.free.push(v); continue; }
      const dx = v.bx - v.ax, dy = v.by - v.ay, len = Math.hypot(dx, dy) || 1;
      v.len = len;
      const ux = dx / len, uy = dy / len, ang = Math.atan2(dy, dx);
      v.contacts.end(dt);
      // Hits: a ripple running along the wall from where the shot landed.
      for (let k = 0; k < FENCE_HITS; k++) {
        const s = v.ripples[k]!;
        const fi = v.state === 1 ? flipFrame(t - v.hitT[k]!, FENCE_HIT_LIFE, rippleFrames.length) : -1;
        s.visible = fi >= 0;
        if (fi < 0) continue;
        const d = v.hitPos[k]! * len;
        s.texture = rippleFrames[fi]!;
        s.position.set(v.ax + ux * d, v.ay + uy * d); s.rotation = ang;
        s.scale.set((FENCE_BAND * 2.6) / s.texture.width, (FENCE_BAND * 1.15) / s.texture.height);
        s.alpha = 1;
      }
      // Lasers held on the wall: a steady lit patch each.
      for (let k = 0; k < SHIELD_CONTACTS; k++) {
        const s = v.held[k]!;
        const I = v.state === 1 ? v.contacts.intensity(k) : 0;
        s.visible = I > 0;
        if (I <= 0) continue;
        const d = v.contacts.ang[k]! * FENCE_POS_UNIT;
        s.texture = contactTex;
        s.position.set(v.ax + ux * d, v.ay + uy * d); s.rotation = ang;
        s.scale.set((FENCE_BAND * 2.2) / contactTex.width, (FENCE_BAND * 1.1) / contactTex.height);
        s.alpha = Math.min(1, I * 0.8 * (0.85 + 0.15 * Math.sin(t * 11 + k * 1.7) * Math.sin(t * 4.3 + k)));
      }
      const n = Math.max(1, Math.min(v.segs.length, Math.round(len / FENCE_SEG)));
      const segL = len / n;
      const since = t - v.changedAt;
      const breathe = 0.8 + 0.1 * Math.sin(t * 2.1 + (key % 7));
      for (let k = 0; k < v.segs.length; k++) {
        const s = v.segs[k]!;
        s.visible = k < n;
        if (k >= n) continue;
        const c = (k + 0.5) / n, edge = Math.min(c, 1 - c);
        s.texture = frame;
        s.position.set(v.ax + ux * segL * k, v.ay + uy * segL * k);
        s.rotation = ang; s.scale.set(segL / frame.width, FENCE_BAND / frame.height);
        let a = 0, tint = this.tint;
        if (v.state === 1) {
          // Raising: grows from both posts and meets in the middle.
          const raise = Math.min(1, since / RAISE_S);
          a = edge <= raise * 0.5 + 0.02 ? breathe : 0;
          if (raise < 1 && Math.abs(edge - raise * 0.5) < 0.6 / n) { a = 1.4; tint = 0xeaffff; }
        } else if (v.state === 2) {
          // Gate open: the span pulls back into the posts, leaving a faint guide.
          const fall = Math.min(1, since / 0.35);
          a = edge < (1 - fall) * 0.5 ? breathe : 0.1;
          if (fall >= 1) { a = 0.1; tint = 0x7fe0a4; }
        } else if (since < FALL_S) {
          // Losing power: flickers out.
          a = h01(k * 31 + Math.floor(t * 30), 7) > since / FALL_S ? 1 : 0;
        } else {
          // Down: a faint red sputter.
          tint = 0xff6a5a;
          a = h01(k * 13 + Math.floor(t * 12), 3) > 0.7 ? 0.22 : 0.06;
        }
        s.alpha = a; s.tint = tint;
      }
      for (let k = 0; k < 2; k++) {
        const p = v.posts[k]!;
        p.visible = true;
        p.position.set(k ? v.bx : v.ax, k ? v.by : v.ay);
        p.scale.set(24 / p.texture.width);
        p.alpha = v.state === 1 ? 0.55 : v.state === 2 ? 0.35 : 0.12 + 0.18 * h01(k + Math.floor(t * 9), 5);
        p.tint = v.state === 0 ? 0xff8a6a : 0x9fe6ff;
      }
      for (let k = 0; k < v.sparks.length; k++) {
        const s = v.sparks[k]!;
        const on = v.state === 0;
        s.visible = on;
        if (!on) continue;
        const ph = (t * 2.2 + k * 0.37) % 1;
        const cyc = Math.floor(t * 2.2 + k * 0.37);
        const end = k % 2, px = end ? v.bx : v.ax, py = end ? v.by : v.ay;
        const dir = ang + (end ? Math.PI : 0) + (h01(k + cyc * 7, 9) - 0.5) * 1.6;
        s.position.set(px + Math.cos(dir) * ph * 26, py + Math.sin(dir) * ph * 26); s.rotation = dir;
        s.scale.set(10 / s.texture.width, 2.8 / s.texture.height); s.tint = emberTint(1 - ph);
        s.alpha = h01(k + cyc * 3, 11) > 0.45 ? 1 - ph : 0;
      }
    }
  }

  count(): number { return this.views.size; }

  reset(): void { for (const v of this.views.values()) { this.hideView(v); this.free.push(v); } this.views.clear(); }

  destroy(): void { this.container.destroy({ children: true }); }

  private hideView(v: FenceView): void {
    for (const s of v.ripples) s.visible = false;
    for (const s of v.held) s.visible = false;
    v.contacts.clear();
    v.hitT.fill(-1e9);
    for (const s of v.segs) s.visible = false;
    for (const s of v.posts) s.visible = false;
    for (const s of v.sparks) s.visible = false;
  }

  private make(): FenceView {
    const f0 = this.strip.fx!.frames[0]!, glow = tex(this.glow)!, spark = tex(this.spark)!;
    const mk = (t: Texture, ax: number): Sprite => { const s = new Sprite(t); s.anchor.set(ax, 0.5); s.visible = false; this.container.addChild(s); return s; };
    // Enough segments for the longest fence span (connection range 600 u).
    const segs: Sprite[] = [];
    for (let k = 0; k < 16; k++) segs.push(mk(f0, 0));
    const r0 = this.ripple.fx!.frames[0]!, ct = tex(this.contact)!;
    const ripples: Sprite[] = [], held: Sprite[] = [];
    for (let k = 0; k < FENCE_HITS; k++) ripples.push(mk(r0, 0.5));
    for (let k = 0; k < SHIELD_CONTACTS; k++) { const s = mk(ct, 0.5); s.tint = 0xc8f2ff; held.push(s); }
    for (const s of ripples) s.tint = 0x9fe6ff;
    return {
      len: 1, hitPos: new Float32Array(FENCE_HITS), hitT: new Float32Array(FENCE_HITS).fill(-1e9), hitNext: 0,
      contacts: new ShieldContacts(), ripples, held,
      key: 0, gen: -1, ax: 0, ay: 0, bx: 0, by: 0, state: 1, changedAt: -1e9, prevState: 1,
      segs, posts: [mk(glow, 0.5), mk(glow, 0.5)], sparks: [mk(spark, 1), mk(spark, 1), mk(spark, 1), mk(spark, 1)],
    };
  }
}
