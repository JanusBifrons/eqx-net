/**
 * Ship engine exhaust (new effects, `?fx=new`): a baked flame at every
 * Machined nozzle plus a short hot ribbon through each nozzle's recent path.
 * Replaces today's particle dots, which break into a dotted line at speed
 * (ships fly 450–950 u/s; the dots were shot astern at 200 u/s).
 *
 * Every ship gets it: players, remote players and NPC drones. Players pass
 * their real thrust / boost input; drones have none on the wire, so their
 * engine level follows their speed against the kind's top speed. Speed is
 * measured from the sprite's own movement between frames (the one resolved
 * pose; never re-interpolated), so it works the same for every ship.
 *
 * Inputs are the ship sprite itself (Pixi space). Pooled per sprite key and
 * swept by generation; per frame only scalar writes on pooled sprites and
 * points (invariant #14). Nothing draws until the textures are baked — the
 * caller keeps today's emitter for those ships.
 */
import { Container, MeshRope, Point, Sprite, type Texture } from 'pixi.js';
import type { EffectQuality } from '@core/contracts/IEffects';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { easeTo, exhaustTint, ExhaustRing, flameShape, type FlameShape } from './engineFx.js';

const tex = (h: ArtHandle): Texture | null => (h.state === 'ready' && h.fx ? h.fx.tex : null);

const THRUST_OUT = 0xff7a30, THRUST_CORE = 0xffe0b0, BOOST_OUT = 0x4f9dff, BOOST_CORE = 0xe2f4ff;
/** Ribbon history: points sampled at 60 Hz, so ~0.27 s of path. */
const RING = 16;
const SAMPLE_S = 1 / 60;
/** Input: -1 = unknown (a drone: follow speed), 0 = off, 1 = on. */
export type EngineInput = -1 | 0 | 1;

/** The nozzle list a Machined ship bake carries (local world units). */
export interface Nozzle { x: number; y: number; r: number }

interface NozzleView { flame: Sprite; core: Sprite; glow: Sprite; ring: ExhaustRing; rope: MeshRope; pts: Point[]; r: number; lx: number; ly: number }
interface EngineView {
  /** Pooled nozzle sprites; the first `count` are this hull's. */
  nozzles: NozzleView[]; count: number; src: readonly Nozzle[] | null; gen: number;
  thrust: number; boost: number; px: number; py: number; primed: boolean; acc: number; phase: number;
}

export class FxEngines {
  /** Additive ribbons, under the hulls. */
  readonly trailLayer = new Container();
  /** Additive flames, under the hulls (they start at the nozzle). */
  readonly flameLayer = new Container();
  /** Additive nozzle glows, over the hulls. */
  readonly glowLayer = new Container();
  private readonly live = new Map<string, EngineView>();
  private readonly flame: ArtHandle;
  private readonly core: ArtHandle;
  private readonly trail: ArtHandle;
  private readonly glow: ArtHandle;
  private gen = 0;
  private drawnCount = 0;
  private readonly shape: FlameShape = { len: 0, wid: 0, alpha: 0 };

  constructor(art: ArtService, private readonly getQuality: () => EffectQuality = () => 'high') {
    for (const l of [this.trailLayer, this.flameLayer, this.glowLayer]) { l.eventMode = 'none'; l.blendMode = 'add'; }
    this.flame = art.fx('flame', undefined, undefined, false);
    this.core = art.fx('flameCore', undefined, undefined, false);
    this.trail = art.fx('exhaustTrail', undefined, undefined, false);
    this.glow = art.fx('glow', undefined, undefined, false);
  }

  ready(): boolean {
    return tex(this.flame) !== null && tex(this.core) !== null && tex(this.trail) !== null && tex(this.glow) !== null;
  }

  beginFrame(): void { this.gen++; this.drawnCount = 0; }

  /**
   * Draw ship `key`'s exhaust. `px, py, rot` is the sprite's Pixi pose;
   * `topSpeed` (u/s) normalises speed for drones. Returns false when it
   * can't draw (textures not baked, no nozzles), so the caller keeps
   * today's emitter for that ship.
   */
  draw(key: string, nozzles: readonly Nozzle[], px: number, py: number, rot: number,
    thrustIn: EngineInput, boostIn: EngineInput, topSpeed: number, dtSec: number, nowMs: number): boolean {
    if (nozzles.length === 0 || !this.ready()) return false;
    let v = this.live.get(key);
    if (!v) { v = this.make(); this.live.set(key, v); }
    if (v.src !== nozzles) this.fit(v, nozzles);
    v.gen = this.gen;
    this.drawnCount++;
    // Speed from the sprite's own movement (one pose per frame).
    let speed = 0;
    if (v.primed && dtSec > 0) speed = Math.hypot(px - v.px, py - v.py) / dtSec;
    if (!v.primed || speed > topSpeed * 4) { // first frame or a teleport
      speed = 0; v.primed = true;
      for (const nz of v.nozzles) nz.ring.reset();
    }
    v.px = px; v.py = py;
    const sp = Math.min(1, speed / Math.max(1, topSpeed));
    const tThrust = thrustIn >= 0 ? thrustIn : Math.min(1, sp / 0.45);
    const tBoost = boostIn >= 0 ? boostIn : Math.max(0, Math.min(1, (sp - 0.7) / 0.25));
    v.thrust = easeTo(v.thrust, tThrust, dtSec, 0.12);
    v.boost = easeTo(v.boost, tBoost, dtSec, 0.2);

    const q = this.getQuality();
    const ribbon = q === 'high' || q === 'medium';
    const outT = exhaustTint(THRUST_OUT, BOOST_OUT, v.boost), coreT = exhaustTint(THRUST_CORE, BOOST_CORE, v.boost);
    const c = Math.cos(rot), s = Math.sin(rot);
    // The nose is local -y, so astern is +y turned by rot.
    const astern = rot + Math.PI / 2;
    v.acc += dtSec;
    const sample = v.acc >= SAMPLE_S;
    if (sample) v.acc = v.acc % SAMPLE_S;
    const t = nowMs / 1000;
    for (let n = 0; n < v.count; n++) {
      const nz = v.nozzles[n]!;
      const x = px + nz.lx * c - nz.ly * s, y = py + nz.lx * s + nz.ly * c;
      const flick = Math.sin(t * 53 + v.phase + n * 2.3) * 0.6 + Math.sin(t * 31 + n) * 0.4;
      flameShape(nz.r, v.thrust, v.boost, flick, this.shape);
      nz.flame.visible = true; nz.flame.position.set(x, y); nz.flame.rotation = astern; nz.flame.tint = outT;
      nz.flame.scale.set(this.shape.len / 128, this.shape.wid / 32); nz.flame.alpha = this.shape.alpha;
      nz.core.visible = true; nz.core.position.set(x, y); nz.core.rotation = astern; nz.core.tint = coreT;
      nz.core.scale.set((this.shape.len * 0.55) / 128, (this.shape.wid * 0.8) / 32); nz.core.alpha = Math.min(1, this.shape.alpha * 1.1);
      nz.glow.visible = true; nz.glow.position.set(x, y); nz.glow.tint = coreT;
      nz.glow.scale.set((nz.r * (2.4 + 1.6 * v.thrust + 1.2 * v.boost)) / 32);
      nz.glow.alpha = 0.35 + 0.5 * v.thrust;
      if (sample) nz.ring.push(x, y);
      if (ribbon && nz.ring.length > 1) {
        nz.pts[0]!.set(x, y);
        for (let k = 1; k < nz.pts.length; k++) nz.pts[k]!.set(nz.ring.x(k - 1), nz.ring.y(k - 1));
        nz.rope.visible = true; nz.rope.tint = outT;
        nz.rope.alpha = 0.55 * (0.15 + 0.7 * v.thrust + 0.15 * v.boost);
      } else {
        nz.rope.visible = false;
      }
    }
    return true;
  }

  /** Hide and release ships not drawn this frame. */
  endFrame(): void {
    for (const [key, v] of this.live) {
      if (v.gen === this.gen) continue;
      for (const nz of v.nozzles) { nz.flame.visible = false; nz.core.visible = false; nz.glow.visible = false; nz.rope.visible = false; }
      v.primed = false;
      this.live.delete(key);
      this.free.push(v);
    }
  }

  /** Ships drawn this frame. */
  drawn(): number { return this.drawnCount; }
  /** Whether `key` was drawn this frame (the caller skips today's emitter). */
  drew(key: string): boolean { return this.live.get(key)?.gen === this.gen; }

  destroy(): void {
    this.trailLayer.destroy({ children: true });
    this.flameLayer.destroy({ children: true });
    this.glowLayer.destroy({ children: true });
  }

  private readonly free: EngineView[] = [];
  private phaseSeed = 0;

  private make(): EngineView {
    const v = this.free.pop();
    if (v) { v.thrust = 0; v.boost = 0; v.acc = 0; v.src = null; return v; }
    this.phaseSeed += 2.7;
    return { nozzles: [], count: 0, src: null, gen: -1, thrust: 0, boost: 0, px: 0, py: 0, primed: false, acc: 0, phase: this.phaseSeed };
  }

  /** Size the view's nozzle sprites to a hull (only when the hull changes). */
  private fit(v: EngineView, nozzles: readonly Nozzle[]): void {
    while (v.nozzles.length < nozzles.length) v.nozzles.push(this.makeNozzle());
    for (let n = 0; n < v.nozzles.length; n++) {
      const nz = v.nozzles[n]!;
      const src = nozzles[n];
      if (!src) { nz.flame.visible = false; nz.core.visible = false; nz.glow.visible = false; nz.rope.visible = false; continue; }
      nz.r = src.r; nz.lx = src.x; nz.ly = src.y + src.r * 0.4;
      // Rope thickness lives on its geometry (getter only); set it per hull.
      const geo = nz.rope.geometry as unknown as { _width: number; update(): void };
      geo._width = src.r * 2.4; geo.update();
      nz.ring.reset();
    }
    v.count = nozzles.length;
    v.src = nozzles;
  }

  private makeNozzle(): NozzleView {
    const sprite = (t: Texture, layer: Container, ax: number): Sprite => {
      const sp = new Sprite(t); sp.anchor.set(ax, 0.5); sp.visible = false; layer.addChild(sp); return sp;
    };
    const pts: Point[] = [];
    for (let k = 0; k < RING + 1; k++) pts.push(new Point());
    const rope = new MeshRope({ texture: tex(this.trail)!, points: pts, textureScale: 0, width: 6 });
    rope.visible = false;
    this.trailLayer.addChild(rope);
    return {
      flame: sprite(tex(this.flame)!, this.flameLayer, 0),
      core: sprite(tex(this.core)!, this.flameLayer, 0),
      glow: sprite(tex(this.glow)!, this.glowLayer, 0.5),
      ring: new ExhaustRing(RING), rope, pts, r: 1, lx: 0, ly: 0,
    };
  }
}
