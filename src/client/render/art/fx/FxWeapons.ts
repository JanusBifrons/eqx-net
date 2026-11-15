/**
 * New weapon effects (plan iridescent-seeking-rainbow v3, B3).
 *
 *  - `FxBeams` draws over today's beam pool (which stays the hot core and
 *    keeps the solid-then-fade range contract): a coloured halo and a flowing
 *    energy strip along the solid part, a fading tail beyond it, a muzzle glow,
 *    and a flare where a beam ends on something.
 *  - `FxProjectiles` replaces bolt and tracer shapes with batched sprites: a
 *    glowing head and a short trail behind it along its velocity. A railgun
 *    slug also leaves a violet-blue ion wake on its `wakeLayer` that lingers
 *    where it passed and spreads as it fades (`SLUG_WAKE_LIFE_S`).
 *
 * Both use textures from `ArtService.fx` and draw nothing until those are
 * ready (today's look stays). Sprites are pooled; per frame is scalar writes
 * on pooled sprites only (invariant #14). Inputs are GAME space (Y up).
 */
import { Container, Sprite, TilingSprite, type Texture } from 'pixi.js';
import { beamCoreWidth, type BeamView } from '../../BeamSpritePool.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { NAVAL_SHELL_WEAPON_IDS } from '@core/combat/shellFlight';
import { RAILGUN_BOLT_WIDTH, RAILGUN_RADIUS } from '../../../../shared-types/combat/navalGuns.js';
import type { EffectQuality } from '@core/contracts/IEffects';
import { slugWakeAlpha, slugWakeSegments, slugWakeWidth, SLUG_WAKE_LIFE_S, SLUG_WAKE_TINT } from './turretFx.js';

const tex = (h: ArtHandle): Texture | null => (h.state === 'ready' && h.fx ? h.fx.tex : null);

/** `tint`: the colour the slot's sprites carry now (a heavy beam re-tints its
 *  slot; written only on change). */
interface BeamSlot { halo: Sprite; flow: TilingSprite; tail: Sprite; muzzle: Sprite; flare: Sprite; tint: number }

/** A screen-floored beam's glow sizes per unit of its drawn core width. */
export const FX_GLOW_OVER_CORE = { halo: 2.6, tail: 1.6, muzzle: 2.2, flare: 3.2 } as const;

export class FxBeams {
  readonly container = new Container();
  private readonly slots: BeamSlot[] = [];
  private readonly streak: ArtHandle;
  private readonly flow: ArtHandle;
  private readonly glow: ArtHandle;
  private readonly trail: ArtHandle;

  constructor(art: ArtService, private readonly color: number) {
    this.container.blendMode = 'add';
    this.container.eventMode = 'none';
    this.streak = art.fx('streak', undefined, undefined, false);
    this.flow = art.fx('beamFlow', undefined, undefined, false);
    this.glow = art.fx('glow', undefined, undefined, false);
    this.trail = art.fx('trail', undefined, undefined, false);
  }

  ready(): boolean {
    return tex(this.streak) !== null && tex(this.flow) !== null && tex(this.glow) !== null && tex(this.trail) !== null;
  }

  /** Draw `count` beams (game space). `nowMs` drives the flow and flicker.
   *  `hits` (remote beams, which carry no solid length): whether each one
   *  landed on something; a miss fades out over the last part of its range,
   *  like today's remote beam. `cameraScale` (px per world u): a style with
   *  `minScreenPx` (the heavy beam) keeps its glow wider than its on-screen
   *  core (`FX_GLOW_OVER_CORE`), else at capital zoom the halo sat inside the
   *  core and never showed. */
  setBeams(views: readonly BeamView[], count: number, nowMs: number, hits?: readonly boolean[], cameraScale?: number): void {
    if (!this.ready()) { this.container.visible = false; return; }
    this.container.visible = count > 0;
    while (this.slots.length < count) this.slots.push(this.makeSlot());
    const t = nowMs / 1000;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!;
      const on = i < count;
      s.halo.visible = on; s.flow.visible = on; s.tail.visible = on; s.muzzle.visible = on; s.flare.visible = on;
      if (!on) continue;
      const b = views[i]!;
      const fx = b.fromX, fy = -b.fromY, tx = b.toX, ty = -b.toY;
      const dx = tx - fx, dy = ty - fy;
      const len = Math.hypot(dx, dy);
      if (len < 0.5) { s.halo.visible = false; s.flow.visible = false; s.tail.visible = false; s.muzzle.visible = false; s.flare.visible = false; continue; }
      const ang = Math.atan2(dy, dx);
      // A per-beam style (the capital heavy beam) re-tints the slot and scales
      // its glow; everything else draws in the pool colour at 1x.
      const tint = b.style ? b.style.tint : this.color;
      const k = b.style?.glowScale ?? 1;
      // The drawn core under a screen floor (0: no floor; fighter beams).
      const core = b.style?.minScreenPx !== undefined ? beamCoreWidth(b.style, cameraScale) : 0;
      if (s.tint !== tint) { s.tint = tint; s.halo.tint = tint; s.flow.tint = tint; s.tail.tint = tint; s.muzzle.tint = tint; }
      const solid = Math.min(len, b.solidLen ?? (hits ? (hits[i] ? len : len * 0.55) : len));
      const fl = 0.88 + 0.12 * Math.sin(t * 57 + i * 1.7) * Math.sin(t * 23 + i);
      s.halo.position.set(fx, fy); s.halo.rotation = ang;
      s.halo.scale.set(solid / s.halo.texture.width, (Math.max(20 * k, core * FX_GLOW_OVER_CORE.halo) * fl) / s.halo.texture.height);
      s.flow.position.set(fx, fy); s.flow.rotation = ang;
      s.flow.width = solid; s.flow.scale.y = (8 * k) / s.flow.texture.height;
      s.flow.tilePosition.x = -t * 420;
      const tailLen = len - solid;
      s.tail.visible = tailLen > 1;
      if (tailLen > 1) {
        s.tail.position.set(fx + Math.cos(ang) * solid, fy + Math.sin(ang) * solid); s.tail.rotation = ang;
        s.tail.scale.set(tailLen / s.tail.texture.width, Math.max(12 * k, core * FX_GLOW_OVER_CORE.tail) / s.tail.texture.height);
      }
      s.muzzle.position.set(fx, fy); s.muzzle.scale.set((Math.max(20 * k, core * FX_GLOW_OVER_CORE.muzzle) / s.muzzle.texture.width) * fl);
      // A beam whose solid part reaches its end has landed on something.
      s.flare.visible = tailLen <= 1;
      if (s.flare.visible) { s.flare.position.set(tx, ty); s.flare.scale.set((Math.max(36 * k, core * FX_GLOW_OVER_CORE.flare) / s.flare.texture.width) * fl); }
    }
  }

  hideAll(): void { this.container.visible = false; }

  destroy(): void { this.container.destroy({ children: true }); }

  private makeSlot(): BeamSlot {
    const st = tex(this.streak)!, fl = tex(this.flow)!, gl = tex(this.glow)!, tr = tex(this.trail)!;
    const mk = (t: Texture, tint: number, alpha: number, ax: number): Sprite => {
      const s = new Sprite(t); s.anchor.set(ax, 0.5); s.tint = tint; s.alpha = alpha; this.container.addChild(s); return s;
    };
    const halo = mk(st, this.color, 0.7, 0);
    const flow = new TilingSprite({ texture: fl, width: 1, height: fl.height });
    flow.anchor.set(0, 0.5); flow.tint = this.color; this.container.addChild(flow);
    const tail = mk(tr, this.color, 0.6, 0);
    const muzzle = mk(gl, this.color, 0.9, 0.5);
    const flare = mk(gl, 0xffffff, 0.95, 0.5);
    return { halo, flow, tail, muzzle, flare, tint: this.color };
  }
}

/** How a projectile looks. */
export type FxProjStyle = 'bolt' | 'tracer' | 'shell' | 'slug';

/** A view; a slug's also carries its wake: `wake` sprites (made on first
 *  use), where it was fired (`ox`, `oy` at game ms `t0`; t0 < 0 = no wake),
 *  where it was last drawn (`hx`, `hy` at `th`), its heading and width. */
interface ProjView {
  head: Sprite; core: Sprite; trail: Sprite[]; gen: number;
  wake: Sprite[] | null; ox: number; oy: number; t0: number; hx: number; hy: number; th: number; ang: number; wid: number;
}
/** Wake sprites per slug view (the high tier's `slugWakeSegments`). */
const WAKE_MAX = 10;
/** Slug wakes still fading after their slug has gone (oldest dropped). */
const MAX_FADING = 16;

const BOLT = { len: 30, width: 9, trail: 3, tint: 0xffc860 };
const TRACER = { len: 38, width: 4, trail: 0, tint: 0xffe6a0 };
/** Capital naval shells, per unit of the gun's shell radius (a 16" shell,
 *  radius 6, draws ~240 u long) so they read at capital zoom. */
const SHELL = { len: 40, width: 4, trail: 3, tint: 0xffb347 };
/** The railgun slug (plan beam-slices §7): a long, white-hot streak, per unit
 *  of its shell radius like a shell. Its drawn width is the bolt width, the
 *  width of the channel a kill cuts (`RAILGUN_BOLT_WIDTH`); ~1 km long. */
const SLUG = { len: 200, width: RAILGUN_BOLT_WIDTH / RAILGUN_RADIUS, trail: 3, tint: 0xd8ecff };

/** A shell-like style's streak width per unit of size (the min-screen-size
 *  floor measures it). */
export function fxShellWidth(style: FxProjStyle): number {
  return style === 'slug' ? SLUG.width : SHELL.width;
}

export class FxProjectiles {
  readonly container = new Container();
  /** Railgun slug wakes, drawn under the projectiles. */
  readonly wakeLayer = new Container();
  private readonly live = new Map<string, ProjView>();
  private readonly free: ProjView[] = [];
  /** Wakes of slugs already gone, fading out (`fadingN` in use). */
  private readonly fading: ProjView[] = [];
  private fadingN = 0;
  private readonly streak: ArtHandle;
  private gen = 0;

  /** `quality`: the effects tier (wake pieces per slug); `clock`: the
   *  renderer's game-time effects clock in ms (`fxNow`, #20). */
  constructor(art: ArtService, private readonly quality: () => EffectQuality = () => 'high', private readonly clock: () => number = () => 0) {
    this.container.blendMode = 'add';
    this.container.eventMode = 'none';
    this.wakeLayer.blendMode = 'add';
    this.wakeLayer.eventMode = 'none';
    this.streak = art.fx('streak', undefined, undefined, false);
  }

  ready(): boolean { return tex(this.streak) !== null; }

  /** Start a frame: projectiles not drawn before `endFrame` are released. */
  beginFrame(): void { this.gen++; }

  /**
   * Draw projectile `id` at game-space (x, y) moving (vx, vy). A SHELL's
   * streak trails it: its front is at (x, y) and it is no longer than
   * `flown` (the distance since it was fired). At capital zoom the minimum
   * screen width makes a 16" streak kilometres long; centred, its front ran
   * through the target before the shell landed (owner 2026-11-12, "the shots
   * fired show even after they hit"). Bolts and tracers stay centred.
   */
  draw(id: string, style: FxProjStyle, x: number, y: number, vx: number, vy: number, alpha: number, size = 1, flown = Infinity): void {
    let v = this.live.get(id);
    if (!v) {
      v = this.free.pop() ?? this.make();
      this.live.set(id, v);
    }
    v.gen = this.gen;
    const base = style === 'bolt' ? BOLT : style === 'shell' ? SHELL : style === 'slug' ? SLUG : TRACER;
    // A slug is drawn as a shell: a streak trailing from its front end.
    const shell = style === 'shell' || style === 'slug';
    const k0 = shell ? size : 1;
    const ax = shell ? 1 : 0.5; // shells: anchor on the streak's front end
    const maxLen = shell ? flown : Infinity;
    const fullLen = base.len * k0;
    const spLen = Math.min(fullLen, maxLen);
    // A streak still growing (just fired) keeps its proportions, thin as well
    // as short: capping only its length drew a fat block at the turret.
    const spWid = base.width * k0 * (spLen / fullLen);
    v.head.anchor.x = ax; v.core.anchor.x = ax;
    const px = x, py = -y;
    const sl = Math.hypot(vx, vy) || 1;
    const ux = vx / sl, uy = -vy / sl;
    const ang = Math.atan2(uy, ux);
    const w = v.head.texture.width, h = v.head.texture.height;
    v.head.visible = true; v.core.visible = true;
    v.head.position.set(px, py); v.head.rotation = ang; v.head.tint = base.tint;
    v.head.scale.set(spLen / w, spWid / h); v.head.alpha = alpha * (style === 'bolt' ? 0.85 : 1);
    v.core.position.set(px, py); v.core.rotation = ang;
    v.core.scale.set((spLen * 0.6) / w, (spWid * 0.33 + 0.8) / h); v.core.alpha = alpha;
    for (let k = 0; k < v.trail.length; k++) {
      const tr = v.trail[k]!;
      const back = (k + 1) * (style === 'slug' ? 60 : 12) * k0;
      tr.visible = k < base.trail && back < maxLen;
      if (!tr.visible) continue;
      tr.anchor.x = ax;
      tr.position.set(px - ux * back, py - uy * back); tr.rotation = ang; tr.tint = base.tint;
      tr.scale.set(Math.min(spLen * (0.9 - k * 0.15), maxLen - back) / w, (spWid * (0.8 - k * 0.18)) / h);
      tr.alpha = alpha * (0.42 - k * 0.12);
    }
    if (style === 'slug') {
      const now = this.clock();
      if (v.t0 < 0) {
        // The wake starts at the muzzle: `flown` back along the heading.
        const back = Number.isFinite(flown) ? flown : 0;
        v.ox = px - ux * back; v.oy = py - uy * back;
        v.t0 = now - (back / sl) * 1000;
      }
      v.hx = px; v.hy = py; v.th = now; v.ang = ang; v.wid = spWid;
      this.drawWake(v, now);
    }
  }

  /** Draw a slug's wake: pieces from where it was fired to where it was last
   *  seen, each fading and spreading from when the slug passed it. Returns
   *  whether any piece still shows. Alloc-free after the view's first slug. */
  private drawWake(v: ProjView, now: number): boolean {
    const n = Math.min(WAKE_MAX, slugWakeSegments(this.quality()));
    if (n > 0 && v.wake === null) v.wake = this.makeWake();
    const wake = v.wake;
    if (wake === null) return false;
    const dx = v.hx - v.ox, dy = v.hy - v.oy, L = Math.hypot(dx, dy);
    const w = wake[0]!.texture.width, h = wake[0]!.texture.height;
    const nx = L > 0 ? -dy / L : 0, ny = L > 0 ? dx / L : 0;
    let any = false;
    for (let j = 0; j < wake.length; j++) {
      const s = wake[j]!;
      if (j >= n || L < 1) { s.visible = false; continue; }
      const f = (j + 0.5) / n;
      const age = (now - (v.t0 + f * (v.th - v.t0))) / 1000;
      const a = slugWakeAlpha(age);
      s.visible = a > 0.01;
      if (!s.visible) continue;
      any = true;
      const spread = slugWakeWidth(age);
      // It drifts apart a little as it spreads (an ion trail, not a rod).
      const drift = Math.sin(j * 2.3 + v.t0 * 0.001) * v.wid * 0.8 * Math.min(1, age / SLUG_WAKE_LIFE_S);
      s.position.set(v.ox + dx * f + nx * drift, v.oy + dy * f + ny * drift);
      s.rotation = v.ang;
      s.scale.set(((L / n) * 1.3) / w, (v.wid * 1.4 * spread) / h);
      s.alpha = a;
    }
    return any;
  }

  private makeWake(): Sprite[] {
    const st = tex(this.streak)!;
    const list: Sprite[] = [];
    for (let j = 0; j < WAKE_MAX; j++) {
      const s = new Sprite(st); s.anchor.set(0.5); s.tint = SLUG_WAKE_TINT; s.visible = false;
      this.wakeLayer.addChild(s); list.push(s);
    }
    return list;
  }

  private hideWake(v: ProjView): void {
    v.t0 = -1;
    if (v.wake) for (const s of v.wake) s.visible = false;
  }

  /** Release projectiles not drawn this frame back to the pool. */
  endFrame(): void {
    for (const [id, v] of this.live) {
      if (v.gen === this.gen) continue;
      v.head.visible = false; v.core.visible = false;
      for (const tr of v.trail) tr.visible = false;
      this.live.delete(id);
      // A slug's wake lingers after it: keep the view until the wake fades.
      if (v.t0 >= 0 && v.wake !== null) {
        if (this.fadingN >= MAX_FADING) { const old = this.fading[0]!; this.hideWake(old); this.free.push(old); this.removeFading(0); }
        this.fading[this.fadingN++] = v;
      } else {
        this.hideWake(v);
        this.free.push(v);
      }
    }
    const now = this.clock();
    for (let i = this.fadingN - 1; i >= 0; i--) {
      const v = this.fading[i]!;
      if (this.drawWake(v, now)) continue;
      this.hideWake(v);
      this.free.push(v);
      this.removeFading(i);
    }
  }

  private removeFading(i: number): void {
    for (let k = i; k < this.fadingN - 1; k++) this.fading[k] = this.fading[k + 1]!;
    this.fadingN--;
  }

  /** Slug wakes drawing now (live slugs and fading ones). */
  wakeCount(): number {
    let n = this.fadingN;
    for (const v of this.live.values()) if (v.t0 >= 0) n++;
    return n;
  }

  liveCount(): number { return this.live.size; }

  destroy(): void { this.container.destroy({ children: true }); this.wakeLayer.destroy({ children: true }); }

  private make(): ProjView {
    const st = tex(this.streak)!;
    const mk = (tint: number): Sprite => { const s = new Sprite(st); s.anchor.set(0.5); s.tint = tint; s.visible = false; this.container.addChild(s); return s; };
    return { head: mk(0xffffff), core: mk(0xffffff), trail: [mk(0xffffff), mk(0xffffff), mk(0xffffff)], gen: -1, wake: null, ox: 0, oy: 0, t0: -1, hx: 0, hy: 0, th: 0, ang: 0, wid: 0 };
  }
}

/** Which new style a projectile gets; null keeps today's shape (pulse orbs,
 *  and beams). Ghosts (the local player's own shots) get it too. */
export function fxProjectileStyle(weaponId: string | undefined, isBeam: boolean): FxProjStyle | null {
  if (isBeam) return null;
  if (weaponId === 'pulse-orb') return null;
  if (weaponId === 'railgun') return 'slug';
  if (weaponId !== undefined && NAVAL_SHELL_WEAPON_IDS.has(weaponId)) return 'shell';
  return weaponId === 'laser' ? 'bolt' : 'tracer';
}
