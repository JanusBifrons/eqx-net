/**
 * Structure restyle 2c — draws a structure's articulation rig parts
 * (`core/articulation`: crane boom/jib/clamp, dock lip, hatch doors, pop-up
 * turret slide); on by default, `?rigs=0` turns them off. Off ⇒ nothing here
 * is constructed and
 * the structure render path is untouched.
 *
 * Not a renderer of its own: the parts hang off the structure's existing
 * sprite and the existing `shipContainer` (plan §8: zIndex bands, the
 * `beamsOverHulls.ts` pattern, no new layer containers in the scene):
 *  - `under` parts (the dock's landing apron, a deck ships park ON) sit in one
 *    small per-structure container on `shipContainer` at `RIG_UNDER_Z`:
 *    below every hull (0) whatever order the sprites were added in. It copies
 *    the host sprite's transform each frame, like `over`;
 *  - `plane` (doors, turret slide) parts are children of the structure
 *    sprite, inserted BELOW its mount cluster: they draw with the structure
 *    body (zIndex 0, above the connector lines), under the gun;
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
 * record and the part graphics are built once per structure; each part's
 * art (2c+: style-C trusses, hubs, hazard paint) is one shared
 * `GraphicsContext` per (rig, part), drawn once and only transformed per
 * frame. Lifted parts (over, plane) also get a drop shadow: a second
 * Graphics on the same context, tinted black, offset down-right.
 *
 * 3e: a rig with an IK chain also carries goods along its arm while a
 * holding clip has a hold length and a cargo direction (`craneCargo.ts`):
 * the cable look's flow (`drawLineLookFlow`, the connector cable carrying
 * goods: same colours, beat and speed) runs along the arm's internal cable
 * (`rigArmCable`, drawn in the beams' static art) from the clamp into the
 * dock (an unload) and/or back out (a load), timed from the clip on the wire;
 * one travelling band over the whole arm.
 */
import { Container, Graphics } from 'pixi.js';
import { drawLineLookFlow, lineLookScale, type LineLookOpts } from './connectorLineLooks.js';
import { connectorVisualInto, type CometSegment, type ConnectorVisual } from './connectorVisual.js';
import { TRANSFER_PULSE_MS } from '../../../core/structures/structureGridConstants.js';
import { createRigPose, evaluateRig, type PlayingClip, type RigPose } from '../../../core/articulation/evaluate.js';
import { CRANE_CARGO_OUT, craneArmPath, craneCargoFlow } from '../../../core/articulation/craneCargo.js';
import { twoBoneIkSolve } from '../../../core/articulation/ikAdapter.js';
import { JOINT_LIFT, liftProgress, rigClipIndex, type DrawLayer, type Rig } from '../../../core/articulation/rig.js';
import { rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import { BEAMS_OVER_HULL_Z } from './beamsOverHulls.js';
import { RIG_LOOK_C, rigArmCable, rigPartContext, type RigArmCable } from './structureRigLook.js';
import { RIG_DRAW_HOOKS } from './structureStyleC.js';
import { rigUnfolds, unfoldPosition } from '../../../core/articulation/unfoldRig.js';
import { RigUnfold } from './structureRigUnfold.js';

/** Draw structure rig parts: on by default (owner, structure restyle);
 *  `?rigs=0` turns them off (the pre-restyle structures). */
export function readRigsFlag(search: string): boolean {
  return !/[?&]rigs=0(?![\w.])/.test(search);
}

/**
 * A clip input to `StructureRigView.update` (null = no clip:
 * the rig's idle pose, e.g. a pop-up turret deployed). The game fills it from the structure row's `rigClip`
 * (`StructureRigs.update`); the art lab sets its own. `targetX/Y` are WORLD game coordinates (Y-up) of a
 * targeted clip's goal (e.g. the parked ship's hold).
 */
export interface StructureRigInput {
  clipId: string;
  startTick: number;
  targetX?: number;
  targetY?: number;
  /** 3e: a holding clip's length (ticks) and cargo direction
   *  (`CRANE_CARGO_*`); absent = no cargo shown. */
  holdTicks?: number;
  cargo?: number;
}

/** zIndex of the over band: above every hull (0), below the beams. */
export const RIG_OVER_Z = BEAMS_OVER_HULL_Z / 2;

/** zIndex of the under band (pad decks): below every hull and structure (0),
 *  so a ship parked on a pad is never hidden by it. */
export const RIG_UNDER_Z = -1;

/** The zIndex band a draw layer lands in on `shipContainer`. `plane` rides
 *  the host sprite (its band, 0); `over` is lifted, `under` sunk. */
export function rigLayerZ(layer: DrawLayer): number {
  return layer === 'over' ? RIG_OVER_Z : layer === 'under' ? RIG_UNDER_Z : 0;
}

/** Game ticks per second (the server sim rate). */
export const RIG_TICKS_PER_SEC = 60;

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
  /** Drop shadow per part (null for under parts), in rig order. */
  readonly shadows: Array<Graphics | null> = [];
  private readonly shadowOff: number[] = [];
  /** Rig part carrying the kind's weapon mount, or -1. */
  readonly mountPart: number;
  /** The pop-up riser (a root LIFT part, 2g+), or -1. Its lift progress
   *  (`liftProgress`) drives the drawn rise: it never moves in the plane
   *  (nor does its collider), it only grows, with a widening shadow; the
   *  mount cluster rides the same and is hidden while fully sunk (the gun is
   *  under the shut hatch). */
  readonly riserPart: number;
  /** Riser lift scale this frame (1 without a riser). */
  liftScale = 1;
  /** Riser lift progress this frame, 0 (sunk) .. 1 (risen); 1 without a riser. */
  lift = 1;
  /** Art under the plane parts (the hatch slot under door leaves; the rig's
   *  `planeUnder` hook), or null. */
  readonly slot: Graphics | null;
  private readonly playing: MutablePlaying = { clipId: '', startTick: 0, target: undefined };
  private readonly targetScratch = { x: 0, y: 0 };
  private readonly xf: PixiXform = { x: 0, y: 0, rotation: 0 };
  /** 3e: the goods flow pulse along the arm, redrawn per frame (null: no IK chain). */
  readonly cargo: Graphics | null = null;
  /** 3e scratch: the arm path (x, y pairs, clamp -> root), the pulse visual, its comet. */
  private readonly armPath: Float64Array;
  private readonly pulseVisual: ConnectorVisual = { color: 0, alpha: 0, width: 0, glowAlpha: 0, glowWidth: 0 };
  private readonly comet: CometSegment = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private cargoDrawn = false;
  /** The arm's internal cable layout, and the flow's look options (its size
   *  re-based per frame on the zoom, so the flow sits on the static body). */
  private readonly armCable: RigArmCable;
  private readonly flowOpts: LineLookOpts = { size: 1, cradles: false };
  /** 3e: the camera scale (CSS px per world u), so the arm's pulse keeps a
   *  cable pulse's on-screen size (`cometSegment` / `lineLookScale`). */
  zoom = 1;
  /** Spinning parts (`PartDef.spin`) run this frame (set by the caller
   *  before `update`, e.g. from `setRunningFrom`); stopped, they hold. */
  running = true;
  /** The rig has a spinning part. */
  readonly hasSpin: boolean;
  /** Game ticks the spinning parts have run (advanced only while running). */
  spinClock = 0;
  private spinLast = Number.NaN;
  private readonly runningOf: ((st: StructureRenderState | undefined) => boolean) | undefined;
  /** Unfold from a crate (`structureRigUnfold.ts`), or null. */
  readonly unfold: RigUnfold | null;
  /** The host's own (body) art alpha this frame: below 1 while unfolding. */
  bodyAlpha = 1;

  constructor(readonly rig: Rig) {
    this.pose = createRigPose(rig);
    this.under.label = 'rig-under';
    this.plane.label = 'rig-plane';
    this.over.label = 'rig-over';
    this.over.zIndex = RIG_OVER_Z;
    this.under.zIndex = RIG_UNDER_Z;
    // A family's special drawing (stage-4 0a): `rigs` in structureStyleC.<family>.ts.
    const hook = Object.prototype.hasOwnProperty.call(RIG_DRAW_HOOKS, rig.id) ? RIG_DRAW_HOOKS[rig.id] : undefined;
    let shadowsOver = 0, shadowsPlane = 0;
    for (let i = 0; i < rig.partCount; i++) {
      const part = rig.parts[i]!;
      const ctx = hook?.partArt?.(rig, i) ?? rigPartContext(rig, i);
      const g = new Graphics(ctx);
      g.label = `rig-part-${part.id}`;
      this.parts.push(g);
      const group = this.groupOf(part.layer);
      if (part.layer === 'under') {
        this.shadows.push(null);
        this.shadowOff.push(0);
      } else {
        // Every shadow of a group sits under all of its parts.
        const sh = new Graphics(ctx);
        sh.label = `rig-shadow-${part.id}`;
        sh.tint = 0x000000;
        sh.alpha = RIG_LOOK_C.shadowAlpha;
        this.shadows.push(sh);
        this.shadowOff.push(part.layer === 'over' ? RIG_LOOK_C.shadowOver : RIG_LOOK_C.shadowPlane);
        group.addChildAt(sh, part.layer === 'over' ? shadowsOver++ : shadowsPlane++);
      }
      group.addChild(g);
    }
    this.unfold = rigUnfolds(rig) ? new RigUnfold(rig) : null;
    if (this.unfold !== null) this.over.addChild(this.unfold.seams);
    this.mountPart = hook?.mountPart?.(rig) ?? -1;
    this.runningOf = hook?.running;
    let spin = false;
    for (let i = 0; i < rig.partCount; i++) if (rig.spins[i] !== 0) spin = true;
    this.hasSpin = spin;
    let riser = -1;
    for (let i = 0; i < rig.partCount; i++) if (rig.parent[i]! < 0 && rig.jointType[i] === JOINT_LIFT) riser = i;
    this.riserPart = riser;
    const slotCtx = hook?.planeUnder?.(rig) ?? null;
    this.slot = slotCtx !== null ? new Graphics(slotCtx) : null;
    if (this.slot !== null) {
      this.slot.label = 'rig-slot';
      this.plane.addChildAt(this.slot, 0); // under every plane shadow and part
    }
    this.armPath = new Float64Array(2 * (rig.maxChain + 1));
    this.armCable = rigArmCable(rig);
    if (rig.maxChain > 0) {
      // Over the arm (light on top of the jib; a pulse casts no shadow).
      const g = new Graphics();
      g.label = 'rig-cargo-pulse';
      g.visible = false;
      this.over.addChild(g);
      this.cargo = g;
    }
  }

  /** Part `i`'s local transform. Allocation-free. */
  private partXform(i: number, xf: PixiXform): PixiXform {
    return partLocalTransform(this.pose, i, xf);
  }

  /** Set `running` from the structure row through the rig's family hook
   *  (`RigDrawHook.running`; none = always running). Allocation-free. */
  setRunningFrom(st: StructureRenderState | undefined): void {
    this.running = this.runningOf === undefined || this.runningOf(st);
  }

  groupOf(layer: DrawLayer): Container {
    return layer === 'over' ? this.over : layer === 'plane' ? this.plane : this.under;
  }

  /**
   * Evaluate the rig at `nowTick` (game ticks, fractional OK) for `input` on
   * a host at game pose (hx, hy, ha) drawn at `scale`, and pose every part.
   * `sunAz` (the sector's sun, Pixi space, direction TO the sun: the art
   * light rig's `sunAz`) turns the rig's aiming parts (`PartDef.aim`, e.g.
   * solar panels) to face it; undefined leaves them at rest. Look only.
   * Allocation-free.
   */
  update(input: StructureRigInput | null, nowTick: number, hx: number, hy: number, ha: number, scale = 1, sunAz?: number): void {
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
    // Spinning parts run on the tick clock (game time, #20) only while
    // `running`; stopped, the clock holds, so they stop where they are.
    if (this.hasSpin) {
      const dt = nowTick - this.spinLast;
      if (this.running && dt > 0) this.spinClock += dt;
      this.spinLast = nowTick;
    }
    // Pixi azimuth -> game angle (y flips), then into the host frame.
    evaluateRig(this.rig, playing, nowTick, this.pose, twoBoneIkSolve, sunAz !== undefined ? -sunAz - ha : undefined,
      this.hasSpin ? this.spinClock : undefined);
    const xf = this.xf;
    const ri = this.riserPart, look = RIG_LOOK_C;
    let lift = 0;
    if (ri >= 0) {
      lift = liftProgress(this.rig, ri, this.pose.value[ri]!);
      this.lift = lift;
      this.liftScale = look.liftScaleRest + (look.liftScaleUp - look.liftScaleRest) * lift;
    }
    for (let i = 0; i < this.parts.length; i++) {
      this.partXform(i, xf);
      const g = this.parts[i]!;
      g.position.set(xf.x, xf.y);
      g.rotation = xf.rotation;
      const sh = this.shadows[i]!;
      if (i === ri && sh !== null) {
        // Fully sunk under the shut hatch: no riser art, no shadow (like the gun).
        const up = lift > 0;
        g.visible = up;
        sh.visible = up;
        g.scale.set(this.liftScale);
        const d = this.shadowOff[i]! + look.liftShadow * lift;
        sh.position.set(xf.x + d, xf.y + d);
        sh.rotation = xf.rotation;
        sh.scale.set(this.liftScale * (1 + 0.08 * lift));
        sh.alpha = look.liftShadowAlphaUp * lift;
      } else if (sh !== null) {
        const d = this.shadowOff[i]!;
        sh.position.set(xf.x + d, xf.y + d);
        sh.rotation = xf.rotation;
      }
    }
    if (this.unfold !== null) this.bodyAlpha = this.unfold.apply(unfoldPosition(playing, nowTick), this.parts, this.shadows, look.shadowAlpha);
    this.poseCargo(input, nowTick);
  }

  /** 3e: run the cable flow pulse along the arm for the playing hold
   *  (clamp -> dock on an unload, dock -> clamp on a load), or hide it. */
  private poseCargo(input: StructureRigInput | null, nowTick: number): void {
    const g = this.cargo;
    if (g === null) return;
    const flow = input !== null && input.holdTicks !== undefined && input.cargo !== undefined
      ? craneCargoFlow(nowTick - input.startTick, input.holdTicks, input.cargo)
      : 0;
    const ci = flow !== 0 ? rigClipIndex(this.rig, input!.clipId) : -1;
    const n = ci >= 0 ? craneArmPath(this.rig, ci, this.pose, this.armPath) : 0;
    if (n < 2) {
      if (this.cargoDrawn) { g.clear(); this.cargoDrawn = false; }
      g.visible = false;
      return;
    }
    // A cable carrying goods: re-pulsed every TRANSFER_PULSE_MS (the 1 Hz
    // beat), its comet crossing in CONNECTOR_PULSE_PERIOD_MS, on game time.
    const nowMs = (nowTick * 1000) / RIG_TICKS_PER_SEC;
    const flashUntil = (Math.floor(nowMs / TRANSFER_PULSE_MS) + 1) * TRANSFER_PULSE_MS;
    const v = connectorVisualInto(this.pulseVisual, flashUntil, nowMs, this.zoom);
    const p = this.armPath;
    let total = 0;
    for (let k = 0; k + 1 < n; k++) total += Math.hypot(p[2 * k + 2]! - p[2 * k]!, p[2 * k + 3]! - p[2 * k + 1]!);
    // Phase over the whole arm, 0 = clamp; a load runs root -> clamp.
    const t = v.pulseT ?? 0;
    const at = (flow === CRANE_CARGO_OUT ? 1 - t : t) * total;
    // The static body is drawn at zoom 1: re-base the size so the flow's
    // width and stations land on it at this zoom.
    const cable = this.armCable, opts = this.flowOpts;
    const scale = lineLookScale('cable', this.zoom);
    const chain = this.rig.clips[ci]!.chain;
    g.clear();
    let cum = 0;
    for (let k = 0; k + 1 < n; k++) {
      // Host frame (y-up) -> the group's Pixi frame (y-down), like the parts.
      const ax = p[2 * k]!, ay = -p[2 * k + 1]!, bx = p[2 * k + 2]!, by = -p[2 * k + 3]!;
      const len = Math.hypot(bx - ax, by - ay);
      // Segment k runs clamp-side -> pivot of chain part n-2-k (reversed:
      // its far-end collar first).
      const part = chain[n - 2 - k]!;
      if (len > 0) {
        opts.size = cable.size[part]! / scale;
        v.pulseT = (at - cum) / len;
        drawLineLookFlow(g, 'cable', v, this.comet, true, ax, ay, bx, by, this.zoom, cable.rb[part]!, cable.ra[part]!, opts);
      }
      cum += len;
    }
    g.visible = true;
    this.cargoDrawn = true;
  }

  /** Ride a mount cluster (children laid out in the host frame) on the
   *  mount part: the cluster moves into the part's frame (on a pop-up riser:
   *  scaled with the lift, hidden while fully sunk under the hatch). The mount ANGLE is
   *  untouched (still `applyMountAngles`, #12). No-op without a mount part. */
  placeMount(cluster: Container): void {
    const i = this.mountPart;
    if (i < 0) return;
    this.partXform(i, this.xf);
    cluster.position.set(this.xf.x, this.xf.y);
    cluster.rotation = this.xf.rotation;
    const riser = i === this.riserPart;
    cluster.scale.set(riser ? this.liftScale : 1);
    cluster.visible = !riser || this.lift > 0;
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
  /** The sprite the plane group hangs off (rebuilt sprite ⇒ re-hang). */
  host: Container | null;
  stamp: number;
}

/**
 * The in-game rig views, one per structure sprite whose kind carries a rig.
 * Created by the renderer only under `?rigs=1`; `swarmSpriteUpdater` calls
 * `update` per visible structure and `sweep` once per frame.
 */
export class StructureRigs {
  /** Scratch: the row's clip with its host-frame target moved to world. */
  private readonly worldInput: StructureRigInput = { clipId: '', startTick: 0 };
  private readonly entries = new Map<string, GameRigEntry>();
  private stamp = 0;
  /** The camera scale this frame (set by the caller before `update`): the
   *  views' goods pulse sizes from it like a cable's (3e). */
  zoom = 1;
  /** The sector's sun azimuth (Pixi space, the art light rig's `sunAz`; set
   *  by the caller before `update`): aiming parts face it. Undefined: rest. */
  sunAz: number | undefined = undefined;
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
   * view, or null when the kind has no rig. `clip` is the structure row's
   * `rigClip` (room state; target in the host frame) and `nowTick` the
   * client's tick clock (`RenderMirror.rigTick`, fractional), so the clip
   * plays from its server start tick: a late joiner sees it mid-way or at
   * its end pose, never restarted. `row` (the structure's room row) says
   * whether its spinning parts run (`RigDrawHook.running`, e.g. reactor fans).
   */
  update(
    spriteKey: string, kindId: string | undefined, sprite: Container,
    hx: number, hy: number, ha: number, clip: StructureRenderState['rigClip'], nowTick: number,
    row?: StructureRenderState,
  ): StructureRigView | null {
    let e = this.entries.get(spriteKey);
    if (e === undefined) {
      const rig = kindId !== undefined ? rigForStructureKind(kindId) : null;
      if (rig === null) return null;
      const view = new StructureRigView(rig);
      this.shipContainer.sortableChildren = true;
      this.shipContainer.addChild(view.under, view.over);
      e = { view, host: null, stamp: 0 };
      this.entries.set(spriteKey, e);
    } else if (e.view.rig !== (kindId !== undefined ? rigForStructureKind(kindId) : null)) {
      // A recycled id with another kind: rebuild from scratch next frame.
      this.drop(spriteKey, e);
      return this.update(spriteKey, kindId, sprite, hx, hy, ha, clip, nowTick, row);
    }
    e.stamp = this.stamp;
    const view = e.view;
    if (e.host !== sprite) {
      // A new (or rebuilt) host sprite: its old children went with it.
      if (view.plane.destroyed) {
        // Rebuilt sprite destroyed our groups with it: rebuild the view.
        this.drop(spriteKey, e);
        return this.update(spriteKey, kindId, sprite, hx, hy, ha, clip, nowTick, row);
      }
      // Plane sits just above the body art and below the world texts and
      // the mount cluster (both added after the body): before the build-ETA
      // text every structure sprite carries, else on top.
      const eta = sprite.getChildByLabel('buildEta');
      if (eta !== null && eta.parent === sprite) sprite.addChildAt(view.plane, sprite.getChildIndex(eta));
      else sprite.addChild(view.plane);
      e.host = sprite;
    }
    let input: StructureRigInput | null = null;
    if (clip !== undefined) {
      input = this.worldInput;
      input.clipId = clip.clipId;
      input.startTick = clip.startTick;
      input.holdTicks = clip.holdTicks;
      input.cargo = clip.cargo;
      if (clip.targetX !== undefined && clip.targetY !== undefined) {
        // Host frame → world game coords (the view takes a world target).
        const c = Math.cos(ha), s = Math.sin(ha);
        input.targetX = hx + clip.targetX * c - clip.targetY * s;
        input.targetY = hy + clip.targetX * s + clip.targetY * c;
      } else {
        input.targetX = undefined;
        input.targetY = undefined;
      }
    }
    view.zoom = this.zoom;
    view.setRunningFrom(row);
    view.update(input, nowTick, hx, hy, ha, 1, this.sunAz);
    followHost(view.over, sprite);
    followHost(view.under, sprite);
    // Unfolding: the panels show while the body art (the sprite) is faded.
    if (view.bodyAlpha < 1) { view.over.alpha = 1; view.under.alpha = 1; }
    return view;
  }

  /** Hide the lifted and sunk groups of a structure that was not posed this
   *  frame (off screen: its sprite is hidden). */
  hide(spriteKey: string): void {
    const e = this.entries.get(spriteKey);
    if (e !== undefined) { e.stamp = this.stamp; e.view.over.visible = false; e.view.under.visible = false; }
  }

  /** End a frame: free the views of structures not seen this frame. */
  sweep(): void {
    this.entries.forEach(this.sweepFn);
  }

  private drop(key: string, e: GameRigEntry): void {
    const v = e.view;
    v.over.parent?.removeChild(v.over);
    v.under.parent?.removeChild(v.under);
    if (!v.plane.destroyed) {
      v.plane.parent?.removeChild(v.plane);
      v.destroy();
    } else {
      // A rebuilt host sprite took the plane group with it.
      if (!v.over.destroyed) v.over.destroy({ children: true });
      if (!v.under.destroyed) v.under.destroy({ children: true });
    }
    this.entries.delete(key);
  }
}

/** A `shipContainer`-level rig group follows its host sprite (alloc-free). */
function followHost(g: Container, sprite: Container): void {
  g.position.copyFrom(sprite.position);
  g.rotation = sprite.rotation;
  g.visible = sprite.visible;
  g.alpha = sprite.alpha;
}
