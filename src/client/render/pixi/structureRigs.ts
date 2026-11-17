/**
 * Structure restyle 2c — draws a structure's articulation rig parts
 * (`core/articulation`: crane boom/jib/clamp, dock lip, hatch doors, pop-up
 * turret slide) behind `?rigs=1`. Flag off ⇒ nothing here is constructed and
 * the structure render path is untouched.
 *
 * Not a renderer of its own: the parts hang off the structure's existing
 * sprite and the existing `shipContainer` (plan §8: zIndex bands, the
 * `beamsOverHulls.ts` pattern, no new layer containers in the scene):
 *  - `under` (dock lip) and `plane` (doors, turret slide) parts are children
 *    of the structure sprite, inserted BELOW its mount cluster: they draw with
 *    the structure body (zIndex 0, above the connector lines, below ships
 *    added after it, like the body itself), under the gun;
 *  - `over` parts (crane) sit in one small per-structure container on
 *    `shipContainer` at `RIG_OVER_Z`: above every hull (0), below the beams
 *    (`BEAMS_OVER_HULL_Z`). It copies the host sprite's transform each frame,
 *    so the crane follows its dock.
 *
 * Every part is posed in the host's local Pixi frame from the host-relative
 * `RigPose` (game space, Y-up) with the standard flip: `(x, -y)`, rotation
 * `-angle` (`partLocalTransform`). The Pixi parent supplies the host's
 * world transform.
 *
 * Per-frame work allocates nothing (invariant #14): the pose, the playing
 * record and the part graphics are built once per structure; part outlines
 * are one shared `GraphicsContext` per (rig, part).
 */
import { Container, Graphics, GraphicsContext } from 'pixi.js';
import { createRigPose, evaluateRig, type PlayingClip, type RigPose } from '../../../core/articulation/evaluate.js';
import { twoBoneIkSolve } from '../../../core/articulation/ikAdapter.js';
import { rigPartIndex, type DrawLayer, type PartDef, type Rig } from '../../../core/articulation/rig.js';
import { DOOR_TURRET_MOUNT, rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import { BEAMS_OVER_HULL_Z } from './beamsOverHulls.js';

/** `?rigs=1`: draw structure rig parts (off by default). */
export function readRigsFlag(search: string): boolean {
  return /[?&]rigs=1\b/.test(search);
}

/**
 * The per-structure clip input the renderer polls each frame (null = no clip:
 * every part at rest). Slice 2e fills it from room state; until then only the
 * art lab sets it. `targetX/Y` are WORLD game coordinates (Y-up) of a
 * targeted clip's goal (e.g. the parked ship's hold).
 */
export interface StructureRigInput {
  clipId: string;
  startTick: number;
  targetX?: number;
  targetY?: number;
}

/** zIndex of the over band: above every hull (0), below the beams. */
export const RIG_OVER_Z = BEAMS_OVER_HULL_Z / 2;

/** The zIndex band a draw layer lands in on `shipContainer`. `under` and
 *  `plane` ride the host sprite (its band, 0); `over` is lifted. */
export function rigLayerZ(layer: DrawLayer): number {
  return layer === 'over' ? RIG_OVER_Z : 0;
}

/** Game ticks per second (the server sim rate). */
export const RIG_TICKS_PER_SEC = 60;
const TICK_MS = 1000 / RIG_TICKS_PER_SEC;

/** A Pixi local transform (caller-owned scratch). */
export interface PixiXform { x: number; y: number; rotation: number }

/** Part `i`'s transform in the host's local Pixi frame: the Y-flip of its
 *  host-relative game pose. Allocation-free. */
export function partLocalTransform(pose: RigPose, i: number, out: PixiXform): PixiXform {
  out.x = pose.x[i]!;
  out.y = -pose.y[i]!;
  out.rotation = -pose.angle[i]!;
  return out;
}

/** Write a WORLD game point into the host frame of a host at (hx, hy)
 *  facing `ha` (game space), drawn at `scale`. Allocation-free. */
export function worldToHost(wx: number, wy: number, hx: number, hy: number, ha: number, scale: number, out: { x: number; y: number }): void {
  const dx = wx - hx, dy = wy - hy;
  const c = Math.cos(ha), s = Math.sin(ha);
  const k = scale !== 0 ? 1 / scale : 1;
  out.x = (dx * c + dy * s) * k;
  out.y = (-dx * s + dy * c) * k;
}

// ---------------------------------------------------------------- the look

/** Gritty style-C rig parts: gunmetal plate, dark outline, rivets and (on
 *  long members) a truss. One shared style for now; a style hook can pick
 *  others later. */
export interface RigPartLook {
  fill: number;
  edge: number;
  rivet: number;
  truss: number;
  /** Under-layer apron (dock lip): hazard chevrons. */
  hazard: number;
}

export const RIG_LOOK_C: RigPartLook = {
  fill: 0x4a5058, edge: 0x14171b, rivet: 0x8b939c, truss: 0x2a2f35, hazard: 0xc9a227,
};

const contexts = new Map<string, GraphicsContext>();

/** The shared outline art of one part (built once per rig part). */
export function rigPartContext(rigId: string, part: PartDef, look: RigPartLook = RIG_LOOK_C): GraphicsContext {
  const key = `${rigId}/${part.id}`;
  const hit = contexts.get(key);
  if (hit !== undefined) return hit;
  const ctx = new GraphicsContext();
  const o = part.outline;
  if (o !== undefined && o.length >= 6) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cx = 0, cy = 0;
    const n = o.length / 2;
    // The outline is in the part's game frame (Y-up): flip it like the pose.
    const pts: number[] = [];
    for (let k = 0; k < n; k++) {
      const x = o[2 * k]!, y = -o[2 * k + 1]!;
      pts.push(x, y);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      cx += x / n; cy += y / n;
    }
    const w = x1 - x0, h = y1 - y0;
    ctx.poly(pts, true).fill({ color: look.fill });
    if (part.layer === 'under') {
      // Hazard chevrons along the apron.
      const step = Math.max(12, h * 1.2);
      for (let x = x0 + step * 0.5; x + h * 0.5 < x1; x += step) {
        ctx.poly([x, y1, x + h * 0.5, y0, x + h * 0.5 + step * 0.35, y0, x + step * 0.35, y1], true)
          .fill({ color: look.hazard, alpha: 0.55 });
      }
    } else if (Math.max(w, h) > 3 * Math.min(w, h)) {
      // A long member: a Warren truss down its length.
      const long = w >= h;
      const len = long ? w : h, thick = long ? h : w;
      const inset = thick * 0.22, step = Math.max(8, thick * 1.1);
      const seg: number[] = [];
      let up = true;
      for (let d = inset; d <= len - inset; d += step) {
        const a = (long ? x0 : y0) + d;
        const b = up ? (long ? y0 : x0) + inset : (long ? y1 : x1) - inset;
        seg.push(long ? a : b, long ? b : a);
        up = !up;
      }
      if (seg.length >= 4) {
        ctx.moveTo(seg[0]!, seg[1]!);
        for (let k = 2; k < seg.length; k += 2) ctx.lineTo(seg[k]!, seg[k + 1]!);
        ctx.stroke({ color: look.truss, width: Math.max(1, thick * 0.12), alpha: 0.9 });
      }
    }
    ctx.poly(pts, true).stroke({ color: look.edge, width: 2, alpha: 0.95 });
    // Rivets: each corner, pulled in toward the centre.
    if (n <= 8) {
      for (let k = 0; k < n; k++) {
        const x = pts[2 * k]!, y = pts[2 * k + 1]!;
        const dx = cx - x, dy = cy - y, d = Math.hypot(dx, dy) || 1;
        const pull = Math.min(4, d * 0.3);
        ctx.circle(x + (dx / d) * pull, y + (dy / d) * pull, 1.3).fill({ color: look.rivet, alpha: 0.85 });
      }
    }
  }
  contexts.set(key, ctx);
  return ctx;
}

// ---------------------------------------------------------------- one structure

/** A mutable `PlayingClip` (the evaluator reads it; nothing is allocated). */
interface MutablePlaying { clipId: string; startTick: number; target: { x: number; y: number } | undefined }

/**
 * One structure's rig: its pose, its part graphics and its three layer
 * groups (`under`, `plane`, `over`), each in the host's local Pixi frame.
 * The caller places the groups (`StructureRigs` in game, the art lab in the
 * lab) and calls `pose` once per frame.
 */
export class StructureRigView {
  readonly pose: RigPose;
  readonly under = new Container();
  readonly plane = new Container();
  readonly over = new Container();
  /** Part graphics in rig order. */
  readonly parts: Graphics[] = [];
  /** Rig part carrying the kind's weapon mount, or -1. */
  readonly mountPart: number;
  private readonly playing: MutablePlaying = { clipId: '', startTick: 0, target: undefined };
  private readonly targetScratch = { x: 0, y: 0 };
  private readonly xf: PixiXform = { x: 0, y: 0, rotation: 0 };

  constructor(readonly rig: Rig) {
    this.pose = createRigPose(rig);
    this.under.label = 'rig-under';
    this.plane.label = 'rig-plane';
    this.over.label = 'rig-over';
    this.over.zIndex = RIG_OVER_Z;
    for (let i = 0; i < rig.partCount; i++) {
      const part = rig.parts[i]!;
      const g = new Graphics(rigPartContext(rig.id, part));
      g.label = `rig-part-${part.id}`;
      this.parts.push(g);
      this.groupOf(part.layer).addChild(g);
    }
    this.mountPart = rig.id === 'sandbox-door-turret' ? rigPartIndex(rig, DOOR_TURRET_MOUNT.partId) : -1;
  }

  groupOf(layer: DrawLayer): Container {
    return layer === 'over' ? this.over : layer === 'plane' ? this.plane : this.under;
  }

  /**
   * Evaluate the rig at `nowTick` (game ticks, fractional OK) for `input` on
   * a host at game pose (hx, hy, ha) drawn at `scale`, and pose every part.
   * Allocation-free.
   */
  update(input: StructureRigInput | null, nowTick: number, hx: number, hy: number, ha: number, scale = 1): void {
    let playing: PlayingClip | null = null;
    if (input !== null) {
      const p = this.playing;
      p.clipId = input.clipId;
      p.startTick = input.startTick;
      if (input.targetX !== undefined && input.targetY !== undefined) {
        worldToHost(input.targetX, input.targetY, hx, hy, ha, scale, this.targetScratch);
        p.target = this.targetScratch;
      } else {
        p.target = undefined;
      }
      playing = p;
    }
    evaluateRig(this.rig, playing, nowTick, this.pose, twoBoneIkSolve);
    const xf = this.xf;
    for (let i = 0; i < this.parts.length; i++) {
      partLocalTransform(this.pose, i, xf);
      const g = this.parts[i]!;
      g.position.set(xf.x, xf.y);
      g.rotation = xf.rotation;
    }
  }

  /** Ride a mount cluster (children laid out in the host frame) on the
   *  mount part: the cluster moves into the part's frame. The mount ANGLE is
   *  untouched (still `applyMountAngles`, #12). No-op without a mount part. */
  placeMount(cluster: Container): void {
    const i = this.mountPart;
    if (i < 0) return;
    partLocalTransform(this.pose, i, this.xf);
    cluster.position.set(this.xf.x, this.xf.y);
    cluster.rotation = this.xf.rotation;
  }

  destroy(): void {
    // Shared contexts survive (a Graphics built on a context does not own it).
    this.under.destroy({ children: true });
    this.plane.destroy({ children: true });
    this.over.destroy({ children: true });
  }
}

// ---------------------------------------------------------------- the game's registry

interface GameRigEntry {
  view: StructureRigView;
  /** The sprite the under/plane groups hang off (rebuilt sprite ⇒ re-hang). */
  host: Container | null;
  /** Clip latch: the input it was seen with and the fx time it was seen. */
  latchClip: string;
  latchStart: number;
  latchFxMs: number;
  stamp: number;
}

/**
 * The in-game rig views, one per structure sprite whose kind carries a rig.
 * Created by the renderer only under `?rigs=1`; `swarmSpriteUpdater` calls
 * `update` per visible structure and `sweep` once per frame.
 */
export class StructureRigs {
  /** Per-structure clip input keyed by structure entityId (see
   *  `StructureRigInput`). The renderer polls it; 2e fills it. */
  readonly inputs = new Map<number, StructureRigInput>();
  private readonly entries = new Map<string, GameRigEntry>();
  private stamp = 0;
  private readonly sweepFn = (e: GameRigEntry, key: string): void => {
    if (e.stamp !== this.stamp) this.drop(key, e);
  };

  constructor(private readonly shipContainer: Container) {}

  /** Number of live rig views (tests, stats). */
  get size(): number { return this.entries.size; }

  /** The view for `spriteKey`, or undefined. */
  viewFor(spriteKey: string): StructureRigView | undefined {
    return this.entries.get(spriteKey)?.view;
  }

  /** Start a frame (before any `update`). */
  begin(): void { this.stamp++; }

  /**
   * Pose `sprite`'s rig for this frame (game pose hx, hy, ha). Returns the
   * view, or null when the kind has no rig. `fxNowMs` is the renderer's
   * game-time clock: a clip's ticks run from when its input was first seen.
   */
  update(
    spriteKey: string, entityId: number, kindId: string | undefined, sprite: Container,
    hx: number, hy: number, ha: number, fxNowMs: number,
  ): StructureRigView | null {
    let e = this.entries.get(spriteKey);
    if (e === undefined) {
      const rig = kindId !== undefined ? rigForStructureKind(kindId) : null;
      if (rig === null) return null;
      const view = new StructureRigView(rig);
      this.shipContainer.sortableChildren = true;
      this.shipContainer.addChild(view.over);
      e = { view, host: null, latchClip: '', latchStart: Number.NaN, latchFxMs: 0, stamp: 0 };
      this.entries.set(spriteKey, e);
    } else if (e.view.rig !== (kindId !== undefined ? rigForStructureKind(kindId) : null)) {
      // A recycled id with another kind: rebuild from scratch next frame.
      this.drop(spriteKey, e);
      return this.update(spriteKey, entityId, kindId, sprite, hx, hy, ha, fxNowMs);
    }
    e.stamp = this.stamp;
    const view = e.view;
    if (e.host !== sprite) {
      // A new (or rebuilt) host sprite: its old children went with it.
      if (view.under.destroyed || view.plane.destroyed) {
        // Rebuilt sprite destroyed our groups with it: rebuild the view.
        this.drop(spriteKey, e);
        return this.update(spriteKey, entityId, kindId, sprite, hx, hy, ha, fxNowMs);
      }
      // Under and plane sit just above the body art and below the world
      // texts and the mount cluster (both added after the body): before the
      // build-ETA text every structure sprite carries, else on top.
      const eta = sprite.getChildByLabel('buildEta');
      if (eta !== null && eta.parent === sprite) {
        const at = sprite.getChildIndex(eta);
        sprite.addChildAt(view.plane, at);
        sprite.addChildAt(view.under, at);
      } else {
        sprite.addChild(view.under, view.plane);
      }
      e.host = sprite;
    }
    const input = this.inputs.get(entityId) ?? null;
    let nowTick = 0;
    if (input !== null) {
      if (input.clipId !== e.latchClip || input.startTick !== e.latchStart) {
        e.latchClip = input.clipId;
        e.latchStart = input.startTick;
        e.latchFxMs = fxNowMs;
      }
      nowTick = input.startTick + (fxNowMs - e.latchFxMs) / TICK_MS;
    }
    view.update(input, nowTick, hx, hy, ha, 1);
    const over = view.over;
    over.position.copyFrom(sprite.position);
    over.rotation = sprite.rotation;
    over.visible = sprite.visible;
    over.alpha = sprite.alpha;
    return view;
  }

  /** Hide the over group of a structure that was not posed this frame
   *  (off screen: its sprite is hidden). */
  hide(spriteKey: string): void {
    const e = this.entries.get(spriteKey);
    if (e !== undefined) { e.stamp = this.stamp; e.view.over.visible = false; }
  }

  /** End a frame: free the views of structures not seen this frame. */
  sweep(): void {
    this.entries.forEach(this.sweepFn);
  }

  private drop(key: string, e: GameRigEntry): void {
    e.view.over.parent?.removeChild(e.view.over);
    if (!e.view.under.destroyed) e.view.under.parent?.removeChild(e.view.under);
    if (!e.view.plane.destroyed) e.view.plane.parent?.removeChild(e.view.plane);
    if (!e.view.under.destroyed) e.view.destroy();
    else if (!e.view.over.destroyed) e.view.over.destroy({ children: true });
    this.entries.delete(key);
  }
}
