/**
 * Structure restyle 2c+: the static art of structure rig parts (style-C
 * trusses, hubs, hazard paint, pads, door leaves, risers), split out of
 * `structureRigs.ts`. Each part's art is one shared `GraphicsContext` per
 * (rig, part), drawn once on first use and only transformed per frame by
 * `StructureRigView` (invariant #14: nothing here runs per frame).
 */
import { GraphicsContext } from 'pixi.js';
import type { PartDef, Rig } from '../../../core/articulation/rig.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import {
  centroid, chamferBox, chevron, ngon, polyBounds, rivetPolys, scalePts, trussPolys,
  type PolySink, type Pt, type Pts,
} from './structureStyleKit.js';
import { drawLineLookBody, lineLookBaseWidth } from './connectorLineLooks.js';

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
  /** Soot (the hatch slot's shaft walls). A truss has no backing: its
   *  lattice is see-through. */
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
  /** The internal cable laid along an arm's lattice (the connector cable
   *  look, `lineLook=cable`, without its own cradles: the truss carries it;
   *  with its plain dark sheath, like the grid cables):
   *  its body width as a fraction of each beam's own truss depth (sized
   *  per segment), so the open lattice still shows each side of it. */
  cableFill: number;
  /** A crane arm's own steel (boom / jib lattice, slew ring, pin hubs,
   *  chord rivets), toned to the settled grid cable: muted gunmetal, so the
   *  arm reads as the same kit as the cables, not a bright frame. */
  armTruss: number;
  armRim: number;
  armRivet: number;
}

export const RIG_LOOK_C: RigPartLook = {
  fill: 0x3c4249, edge: 0x0a0c0e, rivet: 0xa3acb5, truss: 0x88a6c0, soot: 0x14171a,
  hazard: 0xd9a92a, pad: 0x1c1e21, mark: 0xb9b4a2, rim: 0x98a5b1, weight: 0x2c3035,
  lamp: 0xffa030, boomW: 28, jibW: 22, headScale: 1.6,
  shadowOver: 11, shadowPlane: 6, shadowAlpha: 0.5,
  liftScaleRest: 0.88, liftScaleUp: 1.14, liftShadow: 12, liftShadowAlphaUp: 0.6,
  slot: 0x020304, cableFill: 0.36,
  armTruss: 0x464c50, armRim: 0x5a6166, armRivet: 0x6a7277,
};

/** What a part is drawn as, read from the rig's shape (layer, joint,
 *  outline, parent / child links), so a re-tuned catalogue (pivot, lengths,
 *  outlines) just redraws. */
export type RigPartRole = 'pad' | 'base' | 'beam' | 'head' | 'leaf' | 'riser' | 'plate';

/** A rig's special drawing beyond its part roles (stage-4 plan §4 0a): each
 *  family's hooks live in its `structureStyleC.<family>.ts` (`rigs`, keyed by
 *  rig id), assembled as `RIG_DRAW_HOOKS` (structureStyleC.ts). Called once per
 *  view at build time, never per frame (except the alloc-free `running`). */
export interface RigDrawHook {
  /** The part carrying the host kind's weapon mount (`placeMount`), or -1. */
  readonly mountPart?: (rig: Rig) => number;
  /** Art under every plane part and shadow (a hatch slot), or null. */
  readonly planeUnder?: (rig: Rig) => GraphicsContext | null;
  /** Part `i`'s own art instead of its role's (`rigPartContext`), or null
   *  for the role's. One shared context per (rig, part): the hook caches it. */
  readonly partArt?: (rig: Rig, i: number) => GraphicsContext | null;
  /** Part `i`'s lit overlay (e.g. lamp glass over art baked dark), drawn
   *  just over the part with its transform and shown only while the rig is
   *  `running`, or null for none. One shared context per (rig, part): the
   *  hook caches it. */
  readonly partLit?: (rig: Rig, i: number) => GraphicsContext | null;
  /** Is the rig running for this structure row: do its spinning parts
   *  (`PartDef.spin`) turn and its `partLit` overlays show? Polled per frame
   *  (allocation-free); absent = always running. A stopped part holds where
   *  it is. */
  readonly running?: (st: StructureRenderState | undefined) => boolean;
}

/** Rig id -> its drawing hook. */
export type RigDrawHookTable = Readonly<Record<string, RigDrawHook>>;

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
  ctx.circle(x, y, r * 0.78).fill({ color: look.armRim });
  ctx.circle(x, y, r * 0.5).fill({ color: look.fill });
  ctx.circle(x, y, r * 0.22).fill({ color: look.armRivet });
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

/** A lattice beam along the part's long axis: the kit truss, open (no
 *  backing, so what is under the arm shows between the struts) over the
 *  internal cable on an arm (`rigArmCable`),
 *  dark outline, chord rivets; at a joint on the base a slew-ring turntable
 *  and a counterweight (both slew with the beam), at any other joint a pin
 *  hub. */
function beamDepth(rig: Rig, i: number, look: RigPartLook): number {
  const b = outlineBounds(rig.parts[i]!.outline!);
  const along = b.x1 - b.x0 >= b.y1 - b.y0;
  let carriesBeam = false;
  for (let k = 0; k < rig.partCount; k++) if (rig.parent[k] === i && isLong(rig.parts[k]!)) carriesBeam = true;
  const thick = along ? b.y1 - b.y0 : b.x1 - b.x0;
  return Math.max(thick, carriesBeam ? look.boomW : look.jibW);
}

function drawBeam(ctx: GraphicsContext, rig: Rig, i: number, look: RigPartLook): void {
  const b = outlineBounds(rig.parts[i]!.outline!);
  const along = b.x1 - b.x0 >= b.y1 - b.y0;
  const W = beamDepth(rig, i, look);
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
  // No backing: the lattice is open, the internal cable (an arm in an IK
  // chain) runs inside it, under the laces, pivot -> the next joint / tip.
  const cable = rigArmCable(rig, look);
  if (cable.onArm[i] === 1) {
    drawLineLookBody(ctx, 'cable', 0, 0, cable.endX[i]!, cable.endY[i]!, 1, cable.ra[i]!, cable.rb[i]!, { size: cable.size[i]!, cradles: false, lit: false });
  }
  trussPolys(sink, P(s0 + 1, 0), P(s1 - 1, 0), W, look.armTruss, 0);
  ctx.poly(flat(rect), true).stroke({ color: look.edge, width: 2 });
  for (const d of [-1, 1]) rivetPolys(sink, P(s0 + 6, d * (W / 2 - 1.8)), P(s1 - 6, d * (W / 2 - 1.8)), 16, 1.1, look.armRivet);
  if (atBase) {
    // Slew-ring turntable over the pivot, a bolt circle, the king pin.
    ctx.circle(0, 0, R).fill({ color: look.edge });
    ctx.circle(0, 0, R * 0.9).fill({ color: look.armRim });
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

/** A rig's arm cable layout: per part (rig order) whether it carries the
 *  cable (a beam in some clip's IK chain), its far end in the part's Pixi
 *  frame (the next chain joint, or the clip tip), its collar radii at the
 *  pivot (`ra`) and the far end (`rb`), and its cable look size. The
 *  goods flow (`StructureRigView`) runs the same cable flow over it. */
export interface RigArmCable {
  readonly onArm: Uint8Array;
  readonly endX: Float64Array;
  readonly endY: Float64Array;
  readonly ra: Float64Array;
  readonly rb: Float64Array;
  /** Per part: cable look size (`LineLookOpts.size`, 1 = a connector's),
   *  `cableFill` of that beam's truss depth; drawn without cradles. */
  readonly size: Float64Array;
}

const armCables = new Map<string, RigArmCable>();

/** The arm cable of `rig` (built once per rig). */
export function rigArmCable(rig: Rig, look: RigPartLook = RIG_LOOK_C): RigArmCable {
  const hit = armCables.get(rig.id);
  if (hit !== undefined) return hit;
  const n = rig.partCount;
  const onArm = new Uint8Array(n), endX = new Float64Array(n), endY = new Float64Array(n);
  const ra = new Float64Array(n), rb = new Float64Array(n), size = new Float64Array(n);
  for (const clip of rig.clips) {
    const chain = clip.chain;
    for (let s = 0; s < chain.length; s++) {
      const i = chain[s]!;
      const part = rig.parts[i]!;
      if (part.outline === undefined || rigPartRole(rig, i) !== 'beam') continue;
      const W = beamDepth(rig, i, look);
      onArm[i] = 1;
      size[i] = (W * look.cableFill) / lineLookBaseWidth('cable');
      // Game frame (y-up) -> the part's Pixi frame (y-down).
      const next = s + 1 < chain.length ? rig.parts[chain[s + 1]!]! : null;
      endX[i] = next !== null ? next.anchorX : clip.tipX;
      endY[i] = -(next !== null ? next.anchorY : clip.tipY);
      const par = rig.parent[i]!;
      // Collars clear the slew ring at the base, a pin hub elsewhere.
      ra[i] = par >= 0 && rigPartRole(rig, par) === 'base' ? W * 0.85 : W * 0.55;
      rb[i] = W * 0.55;
    }
  }
  const out: RigArmCable = { onArm, endX, endY, ra, rb, size };
  armCables.set(rig.id, out);
  return out;
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
