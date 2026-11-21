/**
 * The Shipyard's build sequence on screen (loop job 3K, mock-up C), the
 * client half of the `shipyard-frame` rig (`core/articulation/rigs/heavyIndustry.ts`):
 *  - the art of the parts that only appear: the hull blocks and fit stages
 *    (a generic sub-cap silhouette, never ship art) and the lamp strips lit;
 *  - `shipyardPartShow` (`RigDrawHook.partShow`): a printed part shows from
 *    lift > 0, cyan "printing" (tint + fade) until its lift reaches 1; a
 *    lamp lights at lift >= 0.5; the hull and its fittings scale to the
 *    kind being built (its radius / the reference half length), and the
 *    gantry + hoist follow them; the hoist grows as it rises (top down);
 *  - `shipyardRowClip` (`RigDrawHook.rowClip`): the client plays it from
 *    the row: at the server's cycle progress (`prodFrac`, job 3L, so a late
 *    joiner sees the right point), advancing with game time between updates;
 *    a blocked yard (hull done, no room) shows it finished; idle rests;
 *  - bays (loop 3R): the hull prints at its bay's keel (`prodBay`,
 *    `shipyardBayKeel`), the gantry working over it; the bay marks baked on
 *    the slip (`SHIPYARD_BAY_MARK_XS`); builds queued behind it
 *    (`prodQueued`) show as faint outlines in the next bays (the keel part's art);
 *  - the print sweep: under a playing clip the gantry sweeps steadily
 *    stern-ward across the hull, the parts printing in behind its print
 *    line and the crane one block ahead, so the printed hull is never under
 *    it (`shipyardSweepGantryX`, `shipyardSweepLift`).
 * Built once / allocation-free per frame (#14).
 */
import { GraphicsContext, type Graphics } from 'pixi.js';
import type { Rig } from '../../../core/articulation/rig.js';
import {
  SHIPYARD_BAY_COUNT, SHIPYARD_BAY_LEN, SHIPYARD_BUILD_BEATS, SHIPYARD_FIT_STAGES, SHIPYARD_FIT_X, SHIPYARD_HOIST_HALF, SHIPYARD_GANTRY_TRAVEL, SHIPYARD_HULL_BLOCK_XS, SHIPYARD_HULL_BLOCKS, SHIPYARD_HULL_HALF_L,
  SHIPYARD_LIGHT_BAR_Y, SHIPYARD_LIGHT_HALF_L, SHIPYARD_LIGHT_HALF_T, shipyardBayKeel, shipyardBuildPlaying, shipyardHullHalfBeam,
  SHIPYARD_SLIP_X1, type ShipyardFitStage,
} from '../../../core/articulation/rigs/heavyIndustry.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import { PROD_STATE, effectiveRecipe, encodeRecipe } from '../../../shared-types/production.js';
import { RECIPES, RECIPE_IDS } from '../../../shared-types/recipes.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { LAMP_AMBER, LAMP_WHITE, SLAB_DARK, SOOT, STEEL } from './structureStyleKit.js';
import type { RigRowClipMemo } from './structureRigLook.js';

/** The print line: the cyan of the restyle's live glass (the yard's
 *  headhouse panel), on a part still being printed and on its seams. */
export const SHIPYARD_PRINT_CYAN = 0x7fd4ff;
/** Game ticks per production pulse (grid pulses are 1 Hz; `Recipe.cyclePulses`). */
const PULSE_TICKS = 60;
/** The hull scale's limits (a fighter's hull is still a readable shape; a
 *  capital, which no sub-cap frame should build, stays inside the slip). */
const HULL_SCALE_MIN = 0.25;
const HULL_SCALE_MAX = 3;

const _fill = { color: 0, alpha: 1 };
const _line = { color: 0x0a0c0e, width: 1.5, alpha: 1 };
const _seam = { color: SHIPYARD_PRINT_CYAN, width: 1, alpha: 0.55 };
const _print = { color: SHIPYARD_PRINT_CYAN, width: 2, alpha: 1 };
/** The finished hull's plating: a light steel, so the new hull reads on the
 *  dark slipway (the yard's own slabs are darker). */
const HULL_PLATE = 0x6a7178;
const HULL_PLATE_LIGHT = 0x8a929a;

/** The bay marks along the slip (local x): one between each pair of bays,
 *  bow to stern (the slip's own ends close the first and last bay). */
export const SHIPYARD_BAY_MARK_XS: readonly number[] = Object.freeze(
  Array.from({ length: SHIPYARD_BAY_COUNT - 1 }, (_, i) => SHIPYARD_SLIP_X1 - (i + 1) * SHIPYARD_BAY_LEN),
);

/** Building a part's printing look (true) or its finished look (false). */
let printing = false;

/** Fill the current path: finished, its colour with a dark outline;
 *  printing, a translucent cyan with a bright cyan print line. */
function paint(g: GraphicsContext, color: number, alpha = 1, outlined = true): void {
  _fill.color = printing ? SHIPYARD_PRINT_CYAN : color;
  _fill.alpha = printing ? 0.3 * alpha : alpha;
  g.fill(_fill);
  if (outlined) g.stroke(printing ? _print : _line);
}

function fillRect(g: GraphicsContext, x: number, y: number, w: number, h: number, color: number): void {
  g.rect(x, y, w, h);
  paint(g, color);
}

// ── art (each in its part's own Pixi frame, y down; symmetric in y) ─────────

/** Hull block `j`: a plated trapezoid on the beam profile, cyan seams. */
function blockContext(j: number): GraphicsContext {
  const g = new GraphicsContext();
  const h = SHIPYARD_HULL_HALF_L / SHIPYARD_HULL_BLOCKS, xc = SHIPYARD_HULL_BLOCK_XS[j]!;
  const w0 = shipyardHullHalfBeam(xc - h), w1 = shipyardHullHalfBeam(xc + h);
  g.poly([-h, -w0, h, -w1, h, w1, -h, w0], true);
  paint(g, HULL_PLATE);
  if (!printing) {
    g.poly([-h + 2, -w0 + 3, h - 2, -w1 + 3, h - 2, w1 - 3, -h + 2, w0 - 3], true);
    paint(g, HULL_PLATE_LIGHT, 0.35, false);
  }
  g.moveTo(-h, -w0).lineTo(-h, w0).moveTo(h, -w1).lineTo(h, w1).moveTo(-h + 2, 0).lineTo(h - 2, 0);
  g.stroke(printing ? _print : _seam);
  return g;
}

function fitContext(s: ShipyardFitStage): GraphicsContext {
  const g = new GraphicsContext();
  if (s === 'deck') {
    fillRect(g, -34, -9, 68, 18, HULL_PLATE_LIGHT);
    for (let x = -24; x <= 24; x += 12) g.moveTo(x, -8).lineTo(x, 8);
    g.stroke(printing ? _print : _seam);
  } else if (s === 'hardpoints') {
    for (const x of [-18, 18]) for (const y of [-9, 9]) {
      fillRect(g, x - 4, y - 4, 8, 8, SLAB_DARK);
      g.circle(x, y, 2); paint(g, SHIPYARD_PRINT_CYAN, 0.8, false);
    }
  } else if (s === 'superstructure') {
    g.poly([-10, -6, -6, -8, 8, -8, 10, -5, 10, 5, 8, 8, -6, 8, -10, 6], true);
    paint(g, HULL_PLATE_LIGHT);
    g.rect(2, -5, 4, 10); paint(g, SHIPYARD_PRINT_CYAN, 0.7, false);
  } else if (s === 'engines') {
    for (const y of [-7, 7]) {
      fillRect(g, -7, y - 5, 14, 10, SOOT);
      g.circle(-6, y, 3); paint(g, LAMP_AMBER, 0.55, false);
    }
  } else {
    for (const y of [-7, 7]) {
      fillRect(g, 0, y - 1.5, 10, 3, STEEL);
      g.circle(0, y, 5); paint(g, SLAB_DARK);
    }
  }
  return g;
}

/** A light strip: two lamp bars, one inside each slip edge, in a steel
 *  housing; dark glass, or lit with a soft halo. */
function lightContext(lit: boolean): GraphicsContext {
  const g = new GraphicsContext(), L = SHIPYARD_LIGHT_HALF_L, t = SHIPYARD_LIGHT_HALF_T;
  for (const s of [-1, 1]) {
    const y = s * SHIPYARD_LIGHT_BAR_Y;
    if (lit) { g.rect(-L - 6, y - t - 6, 2 * L + 12, 2 * t + 12); paint(g, LAMP_WHITE, 0.16, false); }
    fillRect(g, -L, y - t, 2 * L, 2 * t, STEEL);
    g.rect(-L + 3, y - t + 2.5, 2 * L - 6, 2 * t - 5);
    paint(g, lit ? LAMP_WHITE : 0x2a2016, 1, false);
  }
  return g;
}

const ctxCache = new Map<string, GraphicsContext>();
function cached(key: string, make: () => GraphicsContext): GraphicsContext {
  let c = ctxCache.get(key);
  if (c === undefined) { c = make(); ctxCache.set(key, c); }
  return c;
}

/** A light strip's shared art, dark or lit. */
export function shipyardLightContext(lit: boolean): GraphicsContext {
  return cached(lit ? 'light-lit' : 'light', () => lightContext(lit));
}

function printedContext(id: string, print: boolean, make: () => GraphicsContext): GraphicsContext {
  return cached(print ? `${id}:print` : id, () => {
    printing = print;
    try { return make(); } finally { printing = false; }
  });
}

/** The shared art of a printed part (`hull-<j>` / `fit-<stage>`): finished,
 *  or (`print`) its cyan printing look; null for any other id. */
export function shipyardPrintContext(id: string, print = false): GraphicsContext | null {
  if (id.startsWith('hull-')) {
    const j = Number(id.slice(5));
    return j >= 0 && j < SHIPYARD_HULL_BLOCKS ? printedContext(id, print, () => blockContext(j)) : null;
  }
  if (id.startsWith('fit-')) {
    const s = id.slice(4) as ShipyardFitStage;
    return (SHIPYARD_FIT_STAGES as readonly string[]).includes(s) ? printedContext(id, print, () => fitContext(s)) : null;
  }
  return null;
}

// Lazy: built on first use, so importing this module needs no GraphicsContext
// (pixi mocks in unrelated tests omit it).
let keelEmpty: GraphicsContext | null = null;
/** The keel part's art with nothing queued: none (it is only the anchor). */
export function shipyardKeelContext(): GraphicsContext {
  return (keelEmpty ??= new GraphicsContext());
}

const _outline = { color: SHIPYARD_PRINT_CYAN, width: 1.5, alpha: 0.3 };
const _ghost = { color: SHIPYARD_PRINT_CYAN, alpha: 0.05 };
const queuedCtx = new Map<number, GraphicsContext>();

/** The recipe byte of queued build `j` (0-based, after the head): its own
 *  entry in the row's B4 `prodQueue`, else (no queue on the row, e.g. an
 *  older server) the head recipe. Allocation-free. */
function queuedRecipe(st: StructureRenderState | undefined, j: number): number {
  const e = st?.prodQueue?.[j];
  return e !== undefined ? encodeRecipe(e) : (st?.recipe ?? 0);
}

/** The cache key of the outlines for `queued` builds behind `bay` (each
 *  entry's recipe byte, one byte apiece; at most SHIPYARD_BAY_COUNT - 1 drawn). */
function queuedKey(st: StructureRenderState | undefined, bay: number, queued: number): number {
  const q = queued < SHIPYARD_BAY_COUNT - 1 ? queued : SHIPYARD_BAY_COUNT - 1;
  let key = bay * 8 + q;
  for (let j = 0; j < q; j++) key = key * 256 + queuedRecipe(st, j);
  return key;
}

/** The keel part's art with `queued` builds behind the one in `bay`: a
 *  faint print-cyan hull outline (the beam profile at that build's OWN hull
 *  scale, building panels B6) at each next bay's keel, stern-ward, round to
 *  the bow after the last bay. Keel frame (its anchor is local x 0). Built
 *  once per (bay, queued, queued recipes). */
function queuedContext(st: StructureRenderState | undefined, bay: number, queued: number): GraphicsContext {
  const key = queuedKey(st, bay, queued);
  let c = queuedCtx.get(key);
  if (c !== undefined) return c;
  c = new GraphicsContext();
  const n = SHIPYARD_HULL_BLOCKS, H = SHIPYARD_HULL_HALF_L;
  const q = queued < SHIPYARD_BAY_COUNT - 1 ? queued : SHIPYARD_BAY_COUNT - 1;
  for (let j = 1; j <= q; j++) {
    const k = shipyardHullScale(queuedRecipe(st, j - 1));
    const bx = shipyardBayKeel(bay + j).x, pts: number[] = [];
    for (let s = 0; s <= n; s++) { const x = -H + (2 * H * s) / n; pts.push(bx + x * k, -shipyardHullHalfBeam(x) * k); }
    for (let s = n; s >= 0; s--) { const x = -H + (2 * H * s) / n; pts.push(bx + x * k, shipyardHullHalfBeam(x) * k); }
    c.poly(pts, true).fill(_ghost).stroke(_outline);
  }
  queuedCtx.set(key, c);
  return c;
}

// ── per-frame presentation ───────────────────────────────────────────────────

const enum Show { None, Print, Light, Gantry, Hoist, Keel }
let showRig: Rig | null = null;
let showOf: Uint8Array = new Uint8Array(0);
/** Per part of `showRig`: a printed part's finished and printing art. */
let doneCtx: (GraphicsContext | null)[] = [];
let printCtx: (GraphicsContext | null)[] = [];
/** Per printed part of `showRig`: its station x and half extent along the
 *  hull (reference frame), for the print sweep's reveal. */
let sweepX: Float64Array = new Float64Array(0);
let sweepHalf: Float64Array = new Float64Array(0);

function showKinds(rig: Rig): Uint8Array {
  if (showRig !== rig) {
    // Once per rig (not per frame).
    showOf = new Uint8Array(rig.partCount);
    doneCtx = new Array<GraphicsContext | null>(rig.partCount).fill(null);
    printCtx = new Array<GraphicsContext | null>(rig.partCount).fill(null);
    sweepX = new Float64Array(rig.partCount);
    sweepHalf = new Float64Array(rig.partCount).fill(1);
    for (let i = 0; i < rig.partCount; i++) {
      const id = rig.partIds[i]!;
      doneCtx[i] = shipyardPrintContext(id);
      printCtx[i] = shipyardPrintContext(id, true);
      showOf[i] = id.startsWith('hull-') || id.startsWith('fit-') ? Show.Print
        : id.startsWith('light-') ? Show.Light : id === 'gantry' ? Show.Gantry : id === 'gantry-hoist' ? Show.Hoist
            : id === 'keel' ? Show.Keel : Show.None;
      if (id.startsWith('hull-')) { sweepX[i] = SHIPYARD_HULL_BLOCK_XS[Number(id.slice(5))] ?? 0; sweepHalf[i] = BLOCK_HALF; }
      else if (id.startsWith('fit-')) { sweepX[i] = SHIPYARD_FIT_X[id.slice(4) as ShipyardFitStage] ?? 0; sweepHalf[i] = FIT_RAMP; }
    }
    showRig = rig;
  }
  return showOf;
}

const hullScaleOf = new Float64Array(RECIPE_IDS.length + 1).fill(Number.NaN);

/** Half the drawn length of ship kind `id` (world units): the largest
 *  |coordinate| of its silhouette, as `art/fields.ts` `shipExtent` (art is
 *  sized from the silhouette, never the collider radius; not imported, as
 *  that module's graph leads back here). */
function drawnHalfLength(id: string): number {
  const shape = getShipKind(id).shape, s = shape.scale;
  let m = 0;
  if (shape.kind === 'polygon') {
    for (const [x, y] of shape.points) m = Math.max(m, Math.abs(x * s), Math.abs(y * s));
  } else {
    for (const p of shape.parts) for (const [x, y] of p.points) m = Math.max(m, Math.abs((x + p.offsetX) * s), Math.abs((y + p.offsetY) * s));
  }
  return m;
}

/** The scale of the yard's printed hull for its row's recipe byte: the
 *  built kind's drawn half length over the reference half length, clamped. */
export function shipyardHullScale(recipe: number | undefined): number {
  const b = recipe ?? 0;
  const hit = hullScaleOf[b];
  if (hit !== undefined && !Number.isNaN(hit)) return hit;
  let k = 1;
  for (const o of RECIPES[effectiveRecipe('shipyard', b)].outputs) {
    if ('hull' in o) k = drawnHalfLength(o.hull) / SHIPYARD_HULL_HALF_L;
  }
  k = k < HULL_SCALE_MIN ? HULL_SCALE_MIN : k > HULL_SCALE_MAX ? HULL_SCALE_MAX : k;
  if (b < hullScaleOf.length) hullScaleOf[b] = k;
  return k;
}

/** The gantry's drawn x for its clip x at hull scale `k`, the hull printing
 *  at bay keel `bx`: over the hull (|x| <= the reference half length) it
 *  scales with the hull about the bay's keel, so the hoist stays over the
 *  block it sets; beyond, it stretches to the same end stops (the parked
 *  stern position is unchanged). */
export function shipyardGantryX(x: number, k: number, bx = 0): number {
  const H = SHIPYARD_HULL_HALF_L, T = SHIPYARD_GANTRY_TRAVEL, ax = x < 0 ? -x : x;
  if (ax <= H) return bx + x * k;
  const inner = x < 0 ? bx - H * k : bx + H * k, end = x < 0 ? -T : T;
  return inner + ((ax - H) * (end - inner)) / (T - H);
}

// ── the print sweep (art-lab review: the hoist parked over the hull hid it) ──
// The gantry sweeps steadily stern-ward over the hull for the whole print;
// the hull and its fittings print in behind the print line (bow first), and
// the crane rides one block AHEAD of the line, so what is already printed is
// never under it. Pure in the clip time (the build progress).

const BEATS = SHIPYARD_BUILD_BEATS;
/** Clip ticks of the sweep: the first hull beat to the end of the last fit. */
export const SHIPYARD_SWEEP_FROM = BEATS.blocksFrom;
export const SHIPYARD_SWEEP_TO = BEATS.fitFrom + SHIPYARD_FIT_STAGES.length * BEATS.fitStep;
const BLOCK_HALF = SHIPYARD_HULL_HALF_L / SHIPYARD_HULL_BLOCKS;
/** A fitting's reveal ramp half width (reference units) about its station. */
const FIT_RAMP = 8;
/** The print line's ends (reference x): the hull's bow, and past its stern
 *  far enough that the sternmost fitting (the engines) finishes. */
const LINE_BOW = SHIPYARD_HULL_HALF_L;
const LINE_STERN = -(SHIPYARD_HULL_HALF_L + FIT_RAMP);
/** The crane's half footprint along the slip: the hoist at its widest (it
 *  grows to 1.2x as it rises); the truss chords sit inside it. */
export const SHIPYARD_HOIST_FOOT_HALF = SHIPYARD_HOIST_HALF * 1.2;

function smooth(u: number): number {
  const c = u < 0 ? 0 : u > 1 ? 1 : u;
  return c * c * (3 - 2 * c);
}

/** The print line (reference x, bow +) at clip tick `t`: at the bow until
 *  the sweep starts, then steadily stern-ward, past the stern at its end. */
export function shipyardPrintLineX(t: number): number {
  const u = (t - SHIPYARD_SWEEP_FROM) / (SHIPYARD_SWEEP_TO - SHIPYARD_SWEEP_FROM);
  return u <= 0 ? LINE_BOW : u >= 1 ? LINE_STERN : LINE_BOW + (LINE_STERN - LINE_BOW) * u;
}

/** A printed part's lift (0..1) at print line `line`: the share of its span
 *  (station `x` +- `half`, reference x) the line has passed. */
export function shipyardSweepLift(x: number, half: number, line: number): number {
  const v = (x + half - line) / (2 * half);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** The gantry's (and hoist's) drawn x at clip tick `t` for a hull at scale
 *  `k` printing at bay keel `bx`: from the stern park it runs to the bow
 *  before the sweep, rides ahead of the print line (its footprint's bow
 *  edge one block stern of the line), then returns to the park. */
export function shipyardSweepGantryX(t: number, k: number, bx: number): number {
  const T = SHIPYARD_GANTRY_TRAVEL, ahead = SHIPYARD_HOIST_FOOT_HALF + 2 * BLOCK_HALF * k;
  if (t >= BEATS.gantryParked) return -T;
  let x: number;
  if (t < SHIPYARD_SWEEP_FROM) {
    const x0 = bx + LINE_BOW * k - ahead;
    x = -T + (x0 + T) * smooth(t / SHIPYARD_SWEEP_FROM);
  } else if (t <= SHIPYARD_SWEEP_TO) {
    x = bx + shipyardPrintLineX(t) * k - ahead;
  } else {
    const x1 = bx + LINE_STERN * k - ahead;
    x = x1 + (-T - x1) * smooth((t - SHIPYARD_SWEEP_TO) / (BEATS.gantryParked - SHIPYARD_SWEEP_TO));
  }
  return x < -T ? -T : x > T ? T : x;
}

/** `RigDrawHook.partShow` for `shipyard-frame`. Allocation-free. */
export function shipyardPartShow(rig: Rig, i: number, value: number, st: StructureRenderState | undefined, g: Graphics, sh: Graphics | null,
  clipTicks = Number.NaN): void {
  const kind = showKinds(rig)[i];
  if (kind === Show.None) return;
  if (kind === Show.Light) {
    const want = shipyardLightContext(value >= 0.5);
    if (g.context !== want) g.context = want;
    return;
  }
  const bay = st?.prodBay ?? 0;
  if (kind === Show.Keel) {
    const q = st?.prodQueued ?? 0;
    const want = q > 0 ? queuedContext(st, bay, q) : shipyardKeelContext();
    if (g.context !== want) g.context = want;
    return;
  }
  const k = shipyardHullScale(st?.recipe);
  const bx = shipyardBayKeel(bay).x;
  // The view placed the shadow at the part's position + its offset.
  const dx = sh !== null ? sh.x - g.x : 0, dy = sh !== null ? sh.y - g.y : 0;
  const swept = Number.isFinite(clipTicks);
  if (kind === Show.Print) {
    // Under a playing clip the print sweep decides how far the part is in.
    if (swept) value = shipyardSweepLift(sweepX[i]!, sweepHalf[i]!, shipyardPrintLineX(clipTicks));
    const on = value > 0, done = value >= 1;
    g.visible = on;
    // Printing is light, not metal: no shadow until the part is done.
    if (sh !== null) sh.visible = done;
    if (!on) return;
    const want = done ? doneCtx[i]! : printCtx[i]!;
    if (want !== null && g.context !== want) g.context = want;
    g.alpha = done ? 1 : 0.55 + 0.45 * value;
    g.position.set(bx + g.x * k, g.y * k);
    g.scale.set(k);
    if (sh !== null) { sh.position.set(g.x + dx, g.y + dy); sh.scale.set(k); }
    return;
  }
  g.x = swept ? shipyardSweepGantryX(clipTicks, k, bx) : shipyardGantryX(g.x, k, bx);
  if (kind === Show.Hoist) g.scale.set(1 + 0.2 * value);
  if (sh !== null) {
    sh.x = g.x + dx;
    if (kind === Show.Hoist) sh.scale.set(1 + 0.2 * value);
  }
}

/** Game ticks of one build at the row's recipe (blueprint efficiency 100 %). */
export function shipyardCycleTicks(recipe: number | undefined): number {
  return RECIPES[effectiveRecipe('shipyard', recipe ?? 0)].cyclePulses * PULSE_TICKS;
}

/** `RigDrawHook.rowClip` for `shipyard-frame`: the build clip at the
 *  yard's progress, or false (rest) while it is not building. The row's
 *  `prodFrac` (server, one byte, per pulse) anchors the clip whenever it
 *  changes; between updates it advances with game ticks at one recipe cycle
 *  (blueprint efficiency 100 %), held at done until the next update.
 *  Allocation-free. */
export function shipyardRowClip(st: StructureRenderState | undefined, nowTick: number, memo: RigRowClipMemo, out: { clipId: string; startTick: number }): boolean {
  const s = st?.prodState;
  if (s === PROD_STATE.blocked) {
    // Built, waiting for room: the hull sits in the open frame.
    memo.start = Number.NaN;
    memo.seen = Number.NaN;
    shipyardBuildPlaying(1, nowTick, out);
    return true;
  }
  if (s !== PROD_STATE.running) { memo.start = Number.NaN; memo.seen = Number.NaN; return false; }
  const cycle = shipyardCycleTicks(st!.recipe);
  const f = st!.prodFrac ?? 0;
  if (f !== memo.seen || Number.isNaN(memo.start)) {
    memo.seen = f;
    memo.start = nowTick - f * cycle;
  }
  const e = nowTick - memo.start;
  shipyardBuildPlaying(e > 0 ? e / cycle : 0, nowTick, out);
  return true;
}
