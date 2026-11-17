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
 * record and the part graphics are built once per structure; each part's
 * art (2c+: style-C trusses, hubs, hazard paint) is one shared
 * `GraphicsContext` per (rig, part), drawn once and only transformed per
 * frame. Lifted parts (over, plane) also get a drop shadow: a second
 * Graphics on the same context, tinted black, offset down-right.
 */
import { Container, Graphics, GraphicsContext } from 'pixi.js';
import { createRigPose, evaluateRig, type PlayingClip, type RigPose } from '../../../core/articulation/evaluate.js';
import { twoBoneIkSolve } from '../../../core/articulation/ikAdapter.js';
import { JOINT_LIFT, liftProgress, rigPartIndex, type DrawLayer, type PartDef, type Rig } from '../../../core/articulation/rig.js';
import { DOOR_TURRET_MOUNT, rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import { BEAMS_OVER_HULL_Z } from './beamsOverHulls.js';
import {
  centroid, chamferBox, chevron, ngon, polyBounds, rivetPolys, scalePts, trussPolys,
  type PolySink, type Pt, type Pts,
} from './structureStyleKit.js';

/** `?rigs=1`: draw structure rig parts (off by default). */
export function readRigsFlag(search: string): boolean {
  return /[?&]rigs=1\b/.test(search);
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

/** Gritty style-C rig parts (the approved buildings' palette): dark
 *  gunmetal and soot plate, X-braced blue-steel trusses, rivets, amber work
 *  lamps, hazard stripes. One shared style for now; a style hook can pick
 *  others later. Sizes are in host units. */
export interface RigPartLook {
  /** Gunmetal plate (door leaves, clamp body, risers). */
  fill: number;
  /** Dark outline. */
  edge: number;
  rivet: number;
  /** Blue-steel truss chords and posts (the laces are a darker mix). */
  truss: number;
  /** Soot backing behind a truss's lattice. */
  soot: number;
  /** Hazard yellow (stripes are `edge` over it). */
  hazard: number;
  /** Landing-pad deck (under-layer apron). */
  pad: number;
  /** Worn pad paint (bay markings). */
  mark: number;
  /** Slew ring, pin hubs and riser rim: bright machined steel. */
  rim: number;
  /** Counterweight block and plinth. */
  weight: number;
  /** Amber work lamp. */
  lamp: number;
  /** Truss depth: a boom (a beam carrying another beam) and a jib. */
  boomW: number;
  jibW: number;
  /** Clamp-head scale over its outline. */
  headScale: number;
  /** Drop shadow: host-frame offset per lifted layer, and its alpha. */
  shadowOver: number;
  shadowPlane: number;
  shadowAlpha: number;
  /** Pop-up lift (2g): riser + gun scale at rest (sunk in its socket) and
   *  fully risen, the extra host-frame shadow offset at full lift, and the
   *  shadow alpha at full lift. Seen top-down, a lift reads only as growth
   *  and a widening shadow. The shadow fades in from 0 with the rise: a
   *  fully sunk riser casts none (2h). */
  liftScaleRest: number;
  liftScaleUp: number;
  liftShadow: number;
  liftShadowAlphaUp: number;
  /** Hatch slot under the door leaves (seen as they part). */
  slot: number;
}

export const RIG_LOOK_C: RigPartLook = {
  fill: 0x3c4249, edge: 0x0a0c0e, rivet: 0xa3acb5, truss: 0x88a6c0, soot: 0x14171a,
  hazard: 0xd9a92a, pad: 0x1c1e21, mark: 0xb9b4a2, rim: 0x98a5b1, weight: 0x2c3035,
  lamp: 0xffa030, boomW: 28, jibW: 22, headScale: 1.6,
  shadowOver: 11, shadowPlane: 6, shadowAlpha: 0.5,
  liftScaleRest: 0.88, liftScaleUp: 1.14, liftShadow: 12, liftShadowAlphaUp: 0.6,
  slot: 0x020304,
};

/** What a part is drawn as, read from the rig's shape (layer, joint,
 *  outline, parent / child links), so a re-tuned catalogue (pivot, lengths,
 *  outlines) just redraws. */
export type RigPartRole = 'pad' | 'base' | 'beam' | 'head' | 'leaf' | 'riser' | 'plate';

interface Bounds { x0: number; y0: number; x1: number; y1: number }

/** Pixi-frame (y-down) bounds of a game-frame outline. */
function outlineBounds(o: readonly number[], k = 1): Bounds {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let j = 0; j < o.length; j += 2) {
    const x = o[j]! * k, y = -o[j + 1]! * k;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

function isLong(part: PartDef): boolean {
  const o = part.outline;
  if (o === undefined || o.length < 6) return false;
  const b = outlineBounds(o);
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  return Math.max(w, h) > 3 * Math.min(w, h);
}

/** Part `i`'s role in `rig`. */
export function rigPartRole(rig: Rig, i: number): RigPartRole {
  const part = rig.parts[i]!;
  if (part.layer === 'under') return 'pad';
  if (part.joint.type === 'lift') return 'riser';
  if (part.joint.type === 'slide') return 'leaf';
  if (isLong(part)) return 'beam';
  if (rig.parent[i]! < 0) return 'base';
  for (let k = 0; k < rig.partCount; k++) if (rig.parent[k] === i) return 'plate';
  return 'head';
}

/** Pixi-frame (y-down) points of a game-frame outline. */
function outlinePts(o: readonly number[]): Pt[] {
  const pts: Pt[] = [];
  for (let j = 0; j < o.length; j += 2) pts.push([o[j]!, -o[j + 1]!]);
  return pts;
}

function flat(pts: Pts): number[] {
  const out: number[] = [];
  for (const p of pts) out.push(p[0], p[1]);
  return out;
}

/** Paint kit polygons flat into `ctx` (rig parts are not forge-baked; the
 *  kit's laces already come out darker than the chords). */
function flatSink(ctx: GraphicsContext): PolySink {
  return (pts, color) => { ctx.poly(flat(pts), true).fill({ color }); };
}

/** A hazard band `t` deep inside edge a→b (inward = toward `c`): yellow
 *  with dark diagonal stripes. */
function hazardEdge(ctx: GraphicsContext, a: Pt, b: Pt, c: Pt, t: number, look: RigPartLook): void {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L;
  let nx = -uy, ny = ux;
  if ((c[0] - a[0]) * nx + (c[1] - a[1]) * ny < 0) { nx = -nx; ny = -ny; }
  const px = (s: number, d: number): number => a[0] + ux * s + nx * d;
  const py = (s: number, d: number): number => a[1] + uy * s + ny * d;
  ctx.poly([px(0, 0), py(0, 0), px(L, 0), py(L, 0), px(L, t), py(L, t), px(0, t), py(0, t)], true).fill({ color: look.hazard });
  const sw = t * 0.9;
  for (let s = t; s + sw <= L; s += t * 2) {
    ctx.poly([px(s, 0), py(s, 0), px(s + sw, 0), py(s + sw, 0), px(s + sw - t, t), py(s + sw - t, t), px(s - t, t), py(s - t, t)], true)
      .fill({ color: look.edge, alpha: 0.85 });
  }
}

/** A pin hub: dark collar, machined ring, plate, bright pin. */
function hub(ctx: GraphicsContext, x: number, y: number, r: number, look: RigPartLook): void {
  ctx.circle(x, y, r).fill({ color: look.edge });
  ctx.circle(x, y, r * 0.78).fill({ color: look.rim });
  ctx.circle(x, y, r * 0.5).fill({ color: look.fill });
  ctx.circle(x, y, r * 0.22).fill({ color: look.rivet });
}

/** A small hard amber work lamp with a soft halo. */
function workLamp(ctx: GraphicsContext, x: number, y: number, r: number, look: RigPartLook): void {
  ctx.circle(x, y, r * 2.6).fill({ color: look.lamp, alpha: 0.16 });
  ctx.circle(x, y, r * 1.5).fill({ color: look.lamp, alpha: 0.3 });
  ctx.circle(x, y, r).fill({ color: look.edge });
  ctx.circle(x, y, r * 0.72).fill({ color: look.lamp });
  ctx.circle(x - r * 0.2, y - r * 0.2, r * 0.3).fill({ color: 0xfff1d6 });
}

/** Landing pad: dark deck, hazard border, faint bay corner brackets and a
 *  dashed lead-in line, rows of chevrons pointing in toward the host
 *  (`inX`, `inY`: the pixi-frame direction from the pad to the dock). */
function drawPad(ctx: GraphicsContext, pts: Pts, inX: number, inY: number, look: RigPartLook): void {
  const b = polyBounds(pts), c = centroid(pts);
  ctx.poly(flat(pts), true).fill({ color: look.pad });
  const t = Math.max(4, Math.min(10, Math.min(b.w, b.h) * 0.18));
  for (let k = 0; k < pts.length; k++) hazardEdge(ctx, pts[k]!, pts[(k + 1) % pts.length]!, c, t, look);
  ctx.poly(flat(pts), true).stroke({ color: look.edge, width: 2 });
  if (Math.min(b.w, b.h) - 2 * t <= 4) return;
  // Bay corner brackets (faint, worn paint).
  const m = t + 4, arm = Math.min(28, (Math.min(b.w, b.h) - 2 * t) * 0.25), bw = 2.5;
  for (const sx of [0, 1]) {
    for (const sy of [0, 1]) {
      const x = sx ? b.x + b.w - m : b.x + m, y = sy ? b.y + b.h - m : b.y + m;
      ctx.rect(sx ? x - arm : x, sy ? y - bw : y, arm, bw).fill({ color: look.mark, alpha: 0.35 });
      ctx.rect(sx ? x - bw : x, sy ? y - arm : y, bw, arm).fill({ color: look.mark, alpha: 0.35 });
    }
  }
  // Lead-in axis `a` (toward the dock, sign `sg`) and its cross axis `p`.
  const onY = Math.abs(inY) >= Math.abs(inX);
  const sg: 1 | -1 = (onY ? inY : inX) >= 0 ? 1 : -1;
  const a0 = onY ? b.y : b.x, a1 = onY ? b.y + b.h : b.x + b.w;
  const p0 = onY ? b.x : b.y, p1 = onY ? b.x + b.w : b.y + b.h;
  const pc = (p0 + p1) / 2, pw = p1 - p0, al = a1 - a0;
  const at = (p: number, a: number): Pt => (onY ? [p, a] : [a, p]);
  for (let d = t + arm + 8; d + 10 < al - t - arm - 8; d += 18) {
    const q = at(pc - 0.9, a0 + d), r = at(pc + 0.9, a0 + d + 10);
    ctx.rect(Math.min(q[0], r[0]), Math.min(q[1], r[1]), Math.abs(r[0] - q[0]), Math.abs(r[1] - q[1]))
      .fill({ color: look.mark, alpha: 0.22 });
  }
  // Chevron rows on the dock side, pointing in; brightest at the dock.
  const dockA = sg > 0 ? a1 : a0;
  const ch = Math.min(56, pw * 0.16, al * 0.5), cl = ch * 0.45, ct = Math.max(2.5, ch * 0.17);
  const lanes = pw > ch * 5 ? [-0.3, 0, 0.3] : [0];
  const rows = Math.max(1, Math.min(3, Math.floor((al * 0.6) / (cl * 1.5))));
  for (let k = 0; k < rows; k++) {
    const a = dockA - sg * (t + 10 + cl / 2 + k * cl * 1.5);
    for (const lane of lanes) {
      const raw = chevron(0, 0, ch, cl, ct, sg);
      const p2: Pt[] = raw.map(([x, y]) => at(pc + lane * pw + x, a + y));
      ctx.poly(flat(p2), true).fill({ color: look.hazard, alpha: 0.6 - k * 0.15 });
    }
  }
}

/** A lattice beam along the part's long axis: soot backing, the kit truss,
 *  dark outline, chord rivets; at a joint on the base a slew-ring turntable
 *  and a counterweight (both slew with the beam), at any other joint a pin
 *  hub. */
function drawBeam(ctx: GraphicsContext, rig: Rig, i: number, look: RigPartLook): void {
  const b = outlineBounds(rig.parts[i]!.outline!);
  const along = b.x1 - b.x0 >= b.y1 - b.y0;
  let carriesBeam = false;
  for (let k = 0; k < rig.partCount; k++) if (rig.parent[k] === i && isLong(rig.parts[k]!)) carriesBeam = true;
  const thick = along ? b.y1 - b.y0 : b.x1 - b.x0;
  const W = Math.max(thick, carriesBeam ? look.boomW : look.jibW);
  const mid = along ? (b.y0 + b.y1) / 2 : (b.x0 + b.x1) / 2;
  const s0 = along ? b.x0 : b.y0, s1 = along ? b.x1 : b.y1;
  const P = (s: number, d: number): Pt => (along ? [s, mid + d] : [mid + d, s]);
  const par = rig.parent[i]!;
  const atBase = par >= 0 && rigPartRole(rig, par) === 'base';
  const R = W * 0.85;
  const sink = flatSink(ctx);
  if (atBase) {
    // Counterweight block behind the slew ring, ribbed, hazard-edged.
    const cx0 = -R * 0.55, cx1 = cx0 - R * 1.6, hw = W * 0.8;
    const blk: Pt[] = [P(cx0, -hw), P(cx1 + 5, -hw), P(cx1, -hw + 5), P(cx1, hw - 5), P(cx1 + 5, hw), P(cx0, hw)];
    ctx.poly(flat(blk), true).fill({ color: look.weight }).stroke({ color: look.edge, width: 2.5 });
    for (let k = 1; k < 4; k++) {
      const s = cx0 + ((cx1 - cx0) * k) / 4;
      const a = P(s, -hw + 2), z = P(s, hw - 2);
      ctx.moveTo(a[0], a[1]).lineTo(z[0], z[1]);
    }
    ctx.stroke({ color: look.edge, width: 1.2, alpha: 0.8 });
    hazardEdge(ctx, P(cx1, -hw + 5), P(cx1, hw - 5), P(0, 0), 4, look);
  }
  const rect = [P(s0, -W / 2), P(s1, -W / 2), P(s1, W / 2), P(s0, W / 2)];
  ctx.poly(flat(rect), true).fill({ color: look.soot, alpha: 0.75 });
  trussPolys(sink, P(s0 + 1, 0), P(s1 - 1, 0), W, look.truss, 0);
  ctx.poly(flat(rect), true).stroke({ color: look.edge, width: 2 });
  for (const d of [-1, 1]) rivetPolys(sink, P(s0 + 6, d * (W / 2 - 1.8)), P(s1 - 6, d * (W / 2 - 1.8)), 16, 1.1, look.rivet);
  if (atBase) {
    // Slew-ring turntable over the pivot, a bolt circle, the king pin.
    ctx.circle(0, 0, R).fill({ color: look.edge });
    ctx.circle(0, 0, R * 0.9).fill({ color: look.rim });
    ctx.circle(0, 0, R * 0.74).fill({ color: look.fill });
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      ctx.circle(Math.cos(a) * R * 0.82, Math.sin(a) * R * 0.82, 1.2).fill({ color: look.edge });
    }
    hub(ctx, 0, 0, R * 0.42, look);
    const lp = P(-R * 0.55 - R * 1.3, -W * 0.5);
    workLamp(ctx, lp[0], lp[1], 2.6, look);
  } else if (par >= 0) {
    hub(ctx, 0, 0, W * 0.55, look);
  }
}

/** The fixed slewing base: a chunky octagonal plinth, hazard collar on
 *  alternate faces, a bolt ring. */
function drawBase(ctx: GraphicsContext, o: readonly number[], look: RigPartLook): void {
  const b = outlineBounds(o);
  const r = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.5 * 1.5;
  const oct = ngon(0, 0, r, 8, Math.PI / 8);
  ctx.poly(flat(oct), true).fill({ color: look.weight }).stroke({ color: look.edge, width: 2.5 });
  const c: Pt = [0, 0];
  for (let k = 0; k < 8; k += 2) hazardEdge(ctx, oct[k]!, oct[(k + 1) % 8]!, c, 4, look);
  const sink = flatSink(ctx);
  for (let k = 0; k < 8; k++) {
    const a = ((k + 0.5) / 8) * Math.PI * 2 + Math.PI / 8;
    sink(ngon(Math.cos(a) * r * 0.78, Math.sin(a) * r * 0.78, 1.6, 6), look.rivet, 'metal', 1, 0.6);
  }
}

/** The clamp head: a body block, two hazard-striped jaws reaching forward,
 *  an amber lamp and a wrist hub, laid over the (scaled) outline bounds. */
function drawHead(ctx: GraphicsContext, o: readonly number[], look: RigPartLook): void {
  const b = outlineBounds(o, look.headScale);
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const bodyW = w * 0.5, jawT = h * 0.28;
  for (const s of [0, 1]) {
    const y = s ? b.y1 - jawT : b.y0;
    const jx0 = b.x0 + bodyW - 2;
    const tipIn = s ? 0 : jawT * 0.5, tipOut = s ? jawT * 0.5 : jawT;
    const jaw = [jx0, y, b.x1 - 3, y, b.x1, y + tipIn, b.x1, y + tipOut, b.x1 - 3, y + jawT, jx0, y + jawT];
    ctx.poly(jaw, true).fill({ color: look.hazard });
    for (let x = jx0 + 3; x < b.x1 - 3; x += jawT * 1.6) {
      ctx.poly([x, y, x + jawT * 0.7, y, x + jawT * 0.2, y + jawT, x - jawT * 0.5, y + jawT], true).fill({ color: look.edge, alpha: 0.85 });
    }
    ctx.poly(jaw, true).stroke({ color: look.edge, width: 1.8 });
  }
  const body = chamferBox(b.x0, b.y0 + h * 0.12, bodyW, h * 0.76, 4);
  ctx.poly(flat(body), true).fill({ color: look.fill }).stroke({ color: look.edge, width: 2.2 });
  workLamp(ctx, b.x0 + bodyW * 0.72, (b.y0 + b.y1) / 2, 2.8, look);
  hub(ctx, 0, 0, Math.min(bodyW, h) * 0.3, look);
}

/** A sliding door leaf: gunmetal plate, panel seams, corner rivets and a
 *  hazard band on the meeting edge (the edge facing against the slide). */
function drawLeaf(ctx: GraphicsContext, part: PartDef, look: RigPartLook): void {
  const pts = outlinePts(part.outline!);
  const c = centroid(pts);
  ctx.poly(flat(pts), true).fill({ color: look.fill });
  const j = part.joint;
  if (j.type === 'slide') {
    const ax = j.axisX ?? 1, ay = -(j.axisY ?? 0);
    let best = 0, bestDot = Infinity;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k]!, z = pts[(k + 1) % pts.length]!;
      const d = ((a[0] + z[0]) / 2 - c[0]) * ax + ((a[1] + z[1]) / 2 - c[1]) * ay;
      if (d < bestDot) { bestDot = d; best = k; }
    }
    const a = pts[best]!, z = pts[(best + 1) % pts.length]!;
    hazardEdge(ctx, a, z, c, 4.5, look);
    // The meeting edge: a black seam with a bright machined lip behind it,
    // so the split reads at a filmed zoom the moment the leaves part.
    const nx = c[0] - (a[0] + z[0]) / 2, ny = c[1] - (a[1] + z[1]) / 2, nd = Math.hypot(nx, ny) || 1;
    const ox = (nx / nd) * 5.6, oy = (ny / nd) * 5.6;
    ctx.moveTo(a[0] + ox, a[1] + oy).lineTo(z[0] + ox, z[1] + oy).stroke({ color: look.rim, width: 1.6 });
    ctx.moveTo(a[0], a[1]).lineTo(z[0], z[1]).stroke({ color: look.edge, width: 3.2 });
  }
  const b = polyBounds(pts);
  for (let k = 1; k < 3; k++) {
    if (b.w >= b.h) ctx.moveTo(b.x + (b.w * k) / 3, b.y + 1).lineTo(b.x + (b.w * k) / 3, b.y + b.h - 1);
    else ctx.moveTo(b.x + 1, b.y + (b.h * k) / 3).lineTo(b.x + b.w - 1, b.y + (b.h * k) / 3);
  }
  ctx.stroke({ color: look.edge, width: 1.8 });
  ctx.poly(flat(pts), true).stroke({ color: look.edge, width: 2.6 });
  for (const p of pts) {
    const dx = c[0] - p[0], dy = c[1] - p[1], d = Math.hypot(dx, dy) || 1;
    ctx.circle(p[0] + (dx / d) * 3.2, p[1] + (dy / d) * 3.2, 1.3).fill({ color: look.rivet });
  }
}

const slotContexts = new Map<string, GraphicsContext | null>();

/** The hatch slot under a rig's door leaves (2g): the union of the root
 *  leaves' rest outlines as a black slot with a machined rim. The leaves
 *  cover it shut; it shows as a dark gap as they part. Null without leaves. */
export function rigSlotContext(rig: Rig, look: RigPartLook = RIG_LOOK_C): GraphicsContext | null {
  const hit = slotContexts.get(rig.id);
  if (hit !== undefined) return hit;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < rig.partCount; i++) {
    const part = rig.parts[i]!;
    if (rig.parent[i]! >= 0 || part.outline === undefined || rigPartRole(rig, i) !== 'leaf') continue;
    const b = outlineBounds(part.outline);
    // Pixi frame (y-down) at the leaf's rest anchor.
    x0 = Math.min(x0, part.anchorX + b.x0); x1 = Math.max(x1, part.anchorX + b.x1);
    y0 = Math.min(y0, -part.anchorY + b.y0); y1 = Math.max(y1, -part.anchorY + b.y1);
  }
  let ctx: GraphicsContext | null = null;
  if (x0 < x1) {
    ctx = new GraphicsContext();
    ctx.rect(x0 - 1.5, y0 - 1.5, x1 - x0 + 3, y1 - y0 + 3).fill({ color: look.rim });
    ctx.rect(x0, y0, x1 - x0, y1 - y0).fill({ color: look.slot });
    // Shaft walls falling away into the dark.
    ctx.rect(x0 + 2.5, y0 + 2.5, x1 - x0 - 5, y1 - y0 - 5).stroke({ color: look.soot, width: 2 });
  }
  slotContexts.set(rig.id, ctx);
  return ctx;
}

/** The pop-up riser: a bright machined rim round a dark edge, a plated top
 *  with a hazard collar and a rivet ring, so the rise reads. */
function drawRiser(ctx: GraphicsContext, o: readonly number[], look: RigPartLook): void {
  const pts = outlinePts(o);
  const c = centroid(pts);
  ctx.poly(flat(pts), true).fill({ color: look.edge });
  // Hazard collar round the whole riser (outside the gun it carries).
  const collar = scalePts(pts, 0.96);
  for (let k = 0; k < collar.length; k++) hazardEdge(ctx, collar[k]!, collar[(k + 1) % collar.length]!, c, 4.5, look);
  const top = scalePts(pts, 0.7);
  ctx.poly(flat(scalePts(pts, 0.76)), true).fill({ color: look.rim });
  ctx.poly(flat(top), true).fill({ color: look.fill }).stroke({ color: look.edge, width: 1.5 });
  ctx.poly(flat(pts), true).stroke({ color: look.rim, width: 2 });
  const sink = flatSink(ctx);
  const ring = scalePts(pts, 0.55);
  for (let k = 0; k < ring.length; k++) rivetPolys(sink, ring[k]!, ring[(k + 1) % ring.length]!, 9, 1.1, look.rivet);
}

/** A plain plate (fallback): fill, outline, corner rivets. */
function drawPlate(ctx: GraphicsContext, o: readonly number[], look: RigPartLook): void {
  const pts = outlinePts(o);
  ctx.poly(flat(pts), true).fill({ color: look.fill }).stroke({ color: look.edge, width: 2 });
  const c = centroid(pts);
  for (const p of pts) {
    const dx = c[0] - p[0], dy = c[1] - p[1], d = Math.hypot(dx, dy) || 1;
    ctx.circle(p[0] + (dx / d) * 3, p[1] + (dy / d) * 3, 1.2).fill({ color: look.rivet });
  }
}

const contexts = new Map<string, GraphicsContext>();

/** The shared static art of rig part `i` (built once per rig part from its
 *  outline and the rig's shape; posing only transforms it). */
export function rigPartContext(rig: Rig, i: number, look: RigPartLook = RIG_LOOK_C): GraphicsContext {
  const part = rig.parts[i]!;
  const key = `${rig.id}/${part.id}`;
  const hit = contexts.get(key);
  if (hit !== undefined) return hit;
  const ctx = new GraphicsContext();
  const o = part.outline;
  if (o !== undefined && o.length >= 6) {
    switch (rigPartRole(rig, i)) {
      case 'pad': {
        // The host origin seen from the pad (pixi frame): where the dock is.
        const ba = part.baseAngle ?? 0, gx = -part.anchorX, gy = -part.anchorY;
        const lx = gx * Math.cos(ba) + gy * Math.sin(ba), ly = -gx * Math.sin(ba) + gy * Math.cos(ba);
        drawPad(ctx, outlinePts(o), lx, -ly, look);
        break;
      }
      case 'beam': drawBeam(ctx, rig, i, look); break;
      case 'base': drawBase(ctx, o, look); break;
      case 'head': drawHead(ctx, o, look); break;
      case 'leaf': drawLeaf(ctx, part, look); break;
      case 'riser': drawRiser(ctx, o, look); break;
      case 'plate': drawPlate(ctx, o, look); break;
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
  /** Hatch slot under the door leaves, or null. */
  readonly slot: Graphics | null;
  private readonly playing: MutablePlaying = { clipId: '', startTick: 0, target: undefined };
  private readonly targetScratch = { x: 0, y: 0 };
  private readonly xf: PixiXform = { x: 0, y: 0, rotation: 0 };

  constructor(readonly rig: Rig) {
    this.pose = createRigPose(rig);
    this.under.label = 'rig-under';
    this.plane.label = 'rig-plane';
    this.over.label = 'rig-over';
    this.over.zIndex = RIG_OVER_Z;
    let shadowsOver = 0, shadowsPlane = 0;
    for (let i = 0; i < rig.partCount; i++) {
      const part = rig.parts[i]!;
      const ctx = rigPartContext(rig, i);
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
    this.mountPart = rig.id === 'sandbox-door-turret' ? rigPartIndex(rig, DOOR_TURRET_MOUNT.partId) : -1;
    let riser = -1;
    for (let i = 0; i < rig.partCount; i++) if (rig.parent[i]! < 0 && rig.jointType[i] === JOINT_LIFT) riser = i;
    this.riserPart = riser;
    const slotCtx = rigSlotContext(rig);
    this.slot = slotCtx !== null ? new Graphics(slotCtx) : null;
    if (this.slot !== null) {
      this.slot.label = 'rig-slot';
      this.plane.addChildAt(this.slot, 0); // under every plane shadow and part
    }
  }

  /** Part `i`'s local transform. Allocation-free. */
  private partXform(i: number, xf: PixiXform): PixiXform {
    return partLocalTransform(this.pose, i, xf);
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
  /** The sprite the under/plane groups hang off (rebuilt sprite ⇒ re-hang). */
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
   * its end pose, never restarted.
   */
  update(
    spriteKey: string, kindId: string | undefined, sprite: Container,
    hx: number, hy: number, ha: number, clip: StructureRenderState['rigClip'], nowTick: number,
  ): StructureRigView | null {
    let e = this.entries.get(spriteKey);
    if (e === undefined) {
      const rig = kindId !== undefined ? rigForStructureKind(kindId) : null;
      if (rig === null) return null;
      const view = new StructureRigView(rig);
      this.shipContainer.sortableChildren = true;
      this.shipContainer.addChild(view.over);
      e = { view, host: null, stamp: 0 };
      this.entries.set(spriteKey, e);
    } else if (e.view.rig !== (kindId !== undefined ? rigForStructureKind(kindId) : null)) {
      // A recycled id with another kind: rebuild from scratch next frame.
      this.drop(spriteKey, e);
      return this.update(spriteKey, kindId, sprite, hx, hy, ha, clip, nowTick);
    }
    e.stamp = this.stamp;
    const view = e.view;
    if (e.host !== sprite) {
      // A new (or rebuilt) host sprite: its old children went with it.
      if (view.under.destroyed || view.plane.destroyed) {
        // Rebuilt sprite destroyed our groups with it: rebuild the view.
        this.drop(spriteKey, e);
        return this.update(spriteKey, kindId, sprite, hx, hy, ha, clip, nowTick);
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
    let input: StructureRigInput | null = null;
    if (clip !== undefined) {
      input = this.worldInput;
      input.clipId = clip.clipId;
      input.startTick = clip.startTick;
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
