/**
 * New weapon effects (plan iridescent-seeking-rainbow v3, B3).
 *
 *  - `FxBeams` draws over today's beam pool (which stays the hot core and
 *    keeps the solid-then-fade range contract): a coloured halo and a flowing
 *    energy strip along the solid part, a fading tail beyond it, a muzzle glow,
 *    and a flare where a beam ends on something.
 *  - `FxProjectiles` replaces bolt and tracer shapes with batched sprites: a
 *    glowing head and a short trail behind it along its velocity.
 *
 * Both use textures from `ArtService.fx` and draw nothing until those are
 * ready (today's look stays). Sprites are pooled; per frame is scalar writes
 * on pooled sprites only (invariant #14). Inputs are GAME space (Y up).
 */
import { Container, Sprite, TilingSprite, type Texture } from 'pixi.js';
import type { BeamView } from '../../BeamSpritePool.js';
import type { ArtHandle, ArtService } from '../ArtService.js';

const tex = (h: ArtHandle): Texture | null => (h.state === 'ready' && h.fx ? h.fx.tex : null);

interface BeamSlot { halo: Sprite; flow: TilingSprite; tail: Sprite; muzzle: Sprite; flare: Sprite }

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
   *  like today's remote beam. */
  setBeams(views: readonly BeamView[], count: number, nowMs: number, hits?: readonly boolean[]): void {
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
      const solid = Math.min(len, b.solidLen ?? (hits ? (hits[i] ? len : len * 0.55) : len));
      const fl = 0.88 + 0.12 * Math.sin(t * 57 + i * 1.7) * Math.sin(t * 23 + i);
      s.halo.position.set(fx, fy); s.halo.rotation = ang;
      s.halo.scale.set(solid / s.halo.texture.width, (20 * fl) / s.halo.texture.height);
      s.flow.position.set(fx, fy); s.flow.rotation = ang;
      s.flow.width = solid; s.flow.scale.y = 8 / s.flow.texture.height;
      s.flow.tilePosition.x = -t * 420;
      const tailLen = len - solid;
      s.tail.visible = tailLen > 1;
      if (tailLen > 1) {
        s.tail.position.set(fx + Math.cos(ang) * solid, fy + Math.sin(ang) * solid); s.tail.rotation = ang;
        s.tail.scale.set(tailLen / s.tail.texture.width, 12 / s.tail.texture.height);
      }
      s.muzzle.position.set(fx, fy); s.muzzle.scale.set((20 / s.muzzle.texture.width) * fl);
      // A beam whose solid part reaches its end has landed on something.
      s.flare.visible = tailLen <= 1;
      if (s.flare.visible) { s.flare.position.set(tx, ty); s.flare.scale.set((36 / s.flare.texture.width) * fl); }
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
    return { halo, flow, tail, muzzle, flare };
  }
}

/** How a projectile looks. */
export type FxProjStyle = 'bolt' | 'tracer';

interface ProjView { head: Sprite; core: Sprite; trail: Sprite[]; gen: number }

const BOLT = { len: 30, width: 9, trail: 3, tint: 0xffc860 };
const TRACER = { len: 38, width: 4, trail: 0, tint: 0xffe6a0 };

export class FxProjectiles {
  readonly container = new Container();
  private readonly live = new Map<string, ProjView>();
  private readonly free: ProjView[] = [];
  private readonly streak: ArtHandle;
  private gen = 0;

  constructor(art: ArtService) {
    this.container.blendMode = 'add';
    this.container.eventMode = 'none';
    this.streak = art.fx('streak', undefined, undefined, false);
  }

  ready(): boolean { return tex(this.streak) !== null; }

  /** Start a frame: projectiles not drawn before `endFrame` are released. */
  beginFrame(): void { this.gen++; }

  /** Draw projectile `id` at game-space (x, y) moving (vx, vy). */
  draw(id: string, style: FxProjStyle, x: number, y: number, vx: number, vy: number, alpha: number): void {
    let v = this.live.get(id);
    if (!v) {
      v = this.free.pop() ?? this.make();
      this.live.set(id, v);
    }
    v.gen = this.gen;
    const sp = style === 'bolt' ? BOLT : TRACER;
    const px = x, py = -y;
    const sl = Math.hypot(vx, vy) || 1;
    const ux = vx / sl, uy = -vy / sl;
    const ang = Math.atan2(uy, ux);
    const w = v.head.texture.width, h = v.head.texture.height;
    v.head.visible = true; v.core.visible = true;
    v.head.position.set(px, py); v.head.rotation = ang; v.head.tint = sp.tint;
    v.head.scale.set(sp.len / w, sp.width / h); v.head.alpha = alpha * (style === 'bolt' ? 0.85 : 1);
    v.core.position.set(px, py); v.core.rotation = ang;
    v.core.scale.set((sp.len * 0.6) / w, (sp.width * 0.33 + 0.8) / h); v.core.alpha = alpha;
    for (let k = 0; k < v.trail.length; k++) {
      const tr = v.trail[k]!;
      tr.visible = k < sp.trail;
      if (!tr.visible) continue;
      const back = (k + 1) * 12;
      tr.position.set(px - ux * back, py - uy * back); tr.rotation = ang; tr.tint = sp.tint;
      tr.scale.set((sp.len * (0.9 - k * 0.15)) / w, (sp.width * (0.8 - k * 0.18)) / h);
      tr.alpha = alpha * (0.42 - k * 0.12);
    }
  }

  /** Release projectiles not drawn this frame back to the pool. */
  endFrame(): void {
    for (const [id, v] of this.live) {
      if (v.gen === this.gen) continue;
      v.head.visible = false; v.core.visible = false;
      for (const tr of v.trail) tr.visible = false;
      this.live.delete(id);
      this.free.push(v);
    }
  }

  liveCount(): number { return this.live.size; }

  destroy(): void { this.container.destroy({ children: true }); }

  private make(): ProjView {
    const st = tex(this.streak)!;
    const mk = (tint: number): Sprite => { const s = new Sprite(st); s.anchor.set(0.5); s.tint = tint; s.visible = false; this.container.addChild(s); return s; };
    return { head: mk(0xffffff), core: mk(0xffffff), trail: [mk(0xffffff), mk(0xffffff), mk(0xffffff)], gen: -1 };
  }
}

/** Which new style a projectile gets; null keeps today's shape (pulse orbs,
 *  and beams). Ghosts (the local player's own shots) get it too. */
export function fxProjectileStyle(weaponId: string | undefined, isBeam: boolean): FxProjStyle | null {
  if (isBeam) return null;
  if (weaponId === 'pulse-orb') return null;
  return weaponId === 'laser' ? 'bolt' : 'tracer';
}
