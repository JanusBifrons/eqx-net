/**
 * Readable construction (`?buildRing=on`, default off until the owner OKs the
 * stills): a progress RING around each unbuilt structure.
 *
 * At build-mode zoom (~0.25) a turret's whole construction stage is a few
 * pixels wide and the small fill bar above it is unreadable. The ring sits
 * round the blueprint's footprint but never shrinks below
 * `BUILD_RING_MIN_PX` on screen, so it stays readable when the camera is
 * pulled back: a faint full track plus a bright arc for the build fraction,
 * clockwise from the top of the screen. The fraction is the hologram's own
 * (`StructureHologram.shownPct`: `interpBuildPct`, the bar's same ramp), so
 * ring, print line and (flag off) bar agree.
 *
 * Perf (phone, invariant #14): the ring is drawn at a fixed unit radius and
 * scaled to size, so its line width grows with it (a bigger ring is a little
 * bolder). The track is ONE shared `GraphicsContext`; the arc is one shared
 * context per progress step (`BUILD_RING_STEPS + 1` at most, built lazily,
 * never freed). Per frame a ring only swaps its arc's context and sets its
 * scale and rotation: no drawing, no allocation after warm-up.
 */
import { Container, Graphics, GraphicsContext } from 'pixi.js';
import { arcSubpath } from '../arcSubpath.js';

/** `?buildRing=on` turns the ring (and the wireframe hologram) on; anything else = off. */
export function readBuildRingFlag(search: string): boolean {
  return /[?&]buildRing=on\b/.test(search);
}

/** Child label of the ring (inside the hologram). */
export const BUILD_RING_LABEL = 'buildRing';
/** The ring never draws smaller than this on screen (CSS px radius). */
export const BUILD_RING_MIN_PX = 22;
/** World units between the footprint's corner and the ring when the footprint sets the size. */
export const BUILD_RING_PAD = 8;
/** Progress steps the arc snaps to (one shared context each). */
export const BUILD_RING_STEPS = 100;
/** The radius the shared art is drawn at; a ring scales it to size. */
const RING_UNIT = 100;
/** Line width at `RING_UNIT` (12%: ~2.6 px at the minimum on-screen size). */
const RING_WIDTH = 12;
/** Ring colours: the construction cyan (track faint, arc bright with a soft glow). */
const RING_COLOR = 0x66ccff;
const RING_CORE = 0xccf4ff;
const TRACK_ALPHA = 0.28;
/** Top of the screen (Pixi y-down); the arc runs clockwise from here. */
export const BUILD_RING_START = -Math.PI / 2;

/** The ring's WORLD radius round a footprint of corner radius `footR` at camera
 *  zoom `zoom` (CSS px per world unit): the footprint plus a pad, but never
 *  under `BUILD_RING_MIN_PX` on screen. Pure. */
export function buildRingRadius(footR: number, zoom: number): number {
  const fit = footR + BUILD_RING_PAD;
  if (!(zoom > 0)) return fit;
  const min = BUILD_RING_MIN_PX / zoom;
  return fit > min ? fit : min;
}

/** The arc step for build fraction `pct` (clamped; 0 = no arc, STEPS = full). */
export function buildRingStep(pct: number): number {
  const p = pct < 0 ? 0 : pct > 1 ? 1 : pct;
  return Math.round(p * BUILD_RING_STEPS);
}

/** The arc's end angle for `step` (it starts at `BUILD_RING_START`). Pure. */
export function buildRingEndAngle(step: number): number {
  return BUILD_RING_START + (2 * Math.PI * step) / BUILD_RING_STEPS;
}

let trackArt: GraphicsContext | null = null;
const arcArt: (GraphicsContext | undefined)[] = [];

function trackContext(): GraphicsContext {
  trackArt ??= arcSubpath(new GraphicsContext(), 0, 0, RING_UNIT, 0, 2 * Math.PI)
    .stroke({ color: RING_COLOR, alpha: TRACK_ALPHA, width: RING_WIDTH });
  return trackArt;
}

function arcContext(step: number): GraphicsContext {
  let c = arcArt[step];
  if (c) return c;
  c = new GraphicsContext();
  if (step > 0) {
    const a1 = buildRingEndAngle(step);
    arcSubpath(c, 0, 0, RING_UNIT, BUILD_RING_START, a1).stroke({ color: RING_COLOR, alpha: 0.35, width: RING_WIDTH * 1.9 });
    arcSubpath(c, 0, 0, RING_UNIT, BUILD_RING_START, a1).stroke({ color: RING_CORE, alpha: 0.95, width: RING_WIDTH });
  }
  arcArt[step] = c;
  return c;
}

/** The progress ring on one blueprint (a child of its hologram). */
export class BuildRing extends Container {
  readonly track: Graphics;
  readonly arc: Graphics;
  /** Arc step drawn now (tests read it). */
  step = -1;
  /** Ring radius in the structure sprite's local units, last update. */
  localR = 0;

  constructor() {
    super();
    this.label = BUILD_RING_LABEL;
    this.track = new Graphics(trackContext());
    this.arc = new Graphics(arcContext(0));
    this.addChild(this.track, this.arc);
  }

  /**
   * Per frame: size the ring for footprint radius `footR` at camera `zoom`,
   * fill it to `pct`, and keep it square to the screen (start at the top,
   * clockwise) whatever the host sprite's turn and build mirror. The host is
   * the structure sprite (`rotation`, `scale`); this ring's parent (the
   * hologram) adds no transform. No allocation after the step's first use.
   */
  update(pct: number, footR: number, zoom: number, host: Container): void {
    const step = buildRingStep(pct);
    if (step !== this.step) { this.step = step; this.arc.context = arcContext(step); }
    const hostScale = Math.abs(host.scale.y) || 1;
    this.localR = buildRingRadius(footR, zoom) / hostScale;
    const k = this.localR / RING_UNIT;
    // Parent = R(rot)·S(m): the child R(-rot·m)·S(m) cancels it (setDeckSlot's rule).
    const m = host.scale.x < 0 ? -1 : 1;
    this.scale.set(m * k, k);
    this.rotation = -host.rotation * m;
  }
}
