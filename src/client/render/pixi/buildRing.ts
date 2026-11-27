/**
 * Readable construction (default on, owner OK; `?buildRing=off` hides it): a
 * progress HEXAGON round each unbuilt structure.
 *
 * At build-mode zoom (~0.25) a turret's whole construction stage was a few
 * pixels of fill bar. The hexagon is pointy-topped like the deck's hexes
 * (`core/hex`, `structureDeckZones` `hexCorners`) and stays upright on
 * screen. A faint full outline is the track; a bright line fills it
 * clockwise from the top vertex along the edges, the build fraction being
 * the fraction of the perimeter drawn. The fraction is the hologram's own
 * (`StructureHologram.shownPct`: `interpBuildPct`, the bar's same ramp).
 *
 * Size: the hexagon's INSCRIBED radius clears a gun's red dashed danger ring
 * (`gunDangerOuterRadius` + `BUILD_HEX_DANGER_GAP`), or the footprint's corner
 * radius + `BUILD_RING_PAD` for a kind without one, and never draws under
 * `BUILD_RING_MIN_PX` on screen, so it reads with the camera pulled back.
 * That floor grows its WORLD size only up to one deck hex tile
 * (`BUILD_RING_MAX_APOTHEM` = `DECK_HEX_INRADIUS`, the tile's centre to edge
 * midpoint), never past it (owner, 2026-11-27). Zoomed out further it just
 * shrinks on screen, and under `BUILD_RING_HIDE_PX` it is hidden
 * (`visible = false`): at that range nobody is looking at construction.
 *
 * Perf (phone, invariant #14): drawn once at a unit circumradius and scaled
 * to size (its line width grows with it). The track is ONE shared
 * `GraphicsContext`; the fill is one shared context per 1 % step
 * (`BUILD_RING_STEPS + 1` at most, built lazily, never freed). Per frame a
 * hexagon only swaps its fill's context and sets its scale and rotation.
 */
import { Container, Graphics, GraphicsContext } from 'pixi.js';
import type { ArcPathSink } from '../arcSubpath.js';
import { gunDangerOuterRadius } from './structureDeckZones.js';
import { DECK_HEX_INRADIUS } from '../../../core/hex/deckCorners.js';

/** `?buildRing=on|off` — default on (owner OK); `?buildRing=off` hides the hexagon (and the wireframe hologram). */
export function readBuildRingFlag(search: string): boolean {
  return !/[?&]buildRing=off\b/.test(search);
}

/** Child label of the hexagon (inside the hologram). */
export const BUILD_RING_LABEL = 'buildRing';
/** The hexagon's inscribed radius never draws under this on screen (CSS px). */
export const BUILD_RING_MIN_PX = 36;
/** The on-screen floor grows the WORLD inscribed radius at most to one deck
 *  hex tile (its inradius, ~650 u), never past it. */
export const BUILD_RING_MAX_APOTHEM = DECK_HEX_INRADIUS;
/** Under this on-screen inscribed radius (CSS px) the hexagon is hidden. */
export const BUILD_RING_HIDE_PX = 10;
/** World units past the footprint's corner radius (kinds with no danger ring). */
export const BUILD_RING_PAD = 12;
/** World units past the outer edge of a gun's danger ring. */
export const BUILD_HEX_DANGER_GAP = 16;
/** Progress steps the fill snaps to (one shared context each). */
export const BUILD_RING_STEPS = 100;
/** Inscribed / circumscribed radius of a regular hexagon (cos 30°). */
export const HEX_APOTHEM_RATIO = Math.sqrt(3) / 2;
/** The circumradius the shared art is drawn at; a hexagon scales it to size. */
const RING_UNIT = 100;
/** Line width at `RING_UNIT` (12 %: ~4.3 px at the minimum on-screen size). */
const RING_WIDTH = 12;
/** Colours: the construction cyan (track faint, fill bright with a soft glow). */
const RING_COLOR = 0x66ccff;
const RING_CORE = 0xccf4ff;
const TRACK_ALPHA = 0.28;

/** The inscribed radius the hexagon must clear for `kindId` (world u): its
 *  danger ring plus a gap, else its footprint corner radius plus a pad. */
export function buildRingClearRadius(kindId: string | undefined, footR: number): number {
  const danger = gunDangerOuterRadius(kindId);
  return danger !== null ? danger + BUILD_HEX_DANGER_GAP : footR + BUILD_RING_PAD;
}

/** The hexagon's WORLD inscribed radius at camera `zoom` (CSS px per world
 *  u): `clearR`, but never under `BUILD_RING_MIN_PX` on screen, that floor
 *  itself capped at one deck hex tile (`BUILD_RING_MAX_APOTHEM`). Pure. */
export function buildRingApothem(clearR: number, zoom: number): number {
  if (!(zoom > 0)) return clearR;
  const px = BUILD_RING_MIN_PX / zoom;
  const min = px < BUILD_RING_MAX_APOTHEM ? px : BUILD_RING_MAX_APOTHEM;
  return clearR > min ? clearR : min;
}

/** The fill step for build fraction `pct` (clamped; 0 = none, STEPS = full). */
export function buildRingStep(pct: number): number {
  const p = pct < 0 ? 0 : pct > 1 ? 1 : pct;
  return Math.round(p * BUILD_RING_STEPS);
}

/** Pointy-top vertex `k` (0 = top, then clockwise on screen) at circumradius
 *  `r`, Pixi frame (y down), into `out`. */
function hexVertexInto(r: number, k: number, out: { x: number; y: number }): void {
  const a = -Math.PI / 2 + ((k % 6) * Math.PI) / 3;
  out.x = r * Math.cos(a);
  out.y = r * Math.sin(a);
}
const _va = { x: 0, y: 0 };
const _vb = { x: 0, y: 0 };

/**
 * The perimeter path for fraction `frac` of a pointy-top hexagon of
 * circumradius `r`: from the top vertex clockwise along the edges, as one
 * open subpath (`moveTo` then `lineTo`s; never `arc`). 0 draws nothing; 1 is
 * the whole outline closed back on the top vertex. Allocates nothing.
 */
export function hexPerimeterPath<T extends ArcPathSink>(g: T, r: number, frac: number): T {
  const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  if (f <= 0) return g;
  const s = f * 6;
  const full = Math.floor(s);
  hexVertexInto(r, 0, _va);
  g.moveTo(_va.x, _va.y);
  for (let k = 1; k <= full; k++) { hexVertexInto(r, k, _va); g.lineTo(_va.x, _va.y); }
  const rem = s - full;
  if (rem > 0) {
    hexVertexInto(r, full, _va);
    hexVertexInto(r, full + 1, _vb);
    g.lineTo(_va.x + (_vb.x - _va.x) * rem, _va.y + (_vb.y - _va.y) * rem);
  }
  return g;
}

let trackArt: GraphicsContext | null = null;
const fillArt: (GraphicsContext | undefined)[] = [];

function trackContext(): GraphicsContext {
  trackArt ??= hexPerimeterPath(new GraphicsContext(), RING_UNIT, 1).closePath()
    .stroke({ color: RING_COLOR, alpha: TRACK_ALPHA, width: RING_WIDTH, join: 'miter' });
  return trackArt;
}

function fillContext(step: number): GraphicsContext {
  let c = fillArt[step];
  if (c) return c;
  c = new GraphicsContext();
  if (step > 0) {
    const f = step / BUILD_RING_STEPS, closed = step === BUILD_RING_STEPS;
    hexPerimeterPath(c, RING_UNIT, f);
    if (closed) c.closePath();
    c.stroke({ color: RING_COLOR, alpha: 0.35, width: RING_WIDTH * 1.9, join: 'miter' });
    hexPerimeterPath(c, RING_UNIT, f);
    if (closed) c.closePath();
    c.stroke({ color: RING_CORE, alpha: 0.95, width: RING_WIDTH, join: 'miter' });
  }
  fillArt[step] = c;
  return c;
}

/** The progress hexagon on one blueprint (a child of its hologram). */
export class BuildRing extends Container {
  readonly track: Graphics;
  /** The bright fill (named `arc` from the ring it replaced). */
  readonly arc: Graphics;
  /** Inscribed radius it must clear (world u; `buildRingClearRadius`). */
  readonly clearR: number;
  /** Fill step drawn now (tests read it). */
  step = -1;
  /** Circumradius (top vertex) in the structure sprite's local units, last update. */
  localR = 0;

  constructor(clearR: number) {
    super();
    this.label = BUILD_RING_LABEL;
    this.clearR = clearR;
    this.track = new Graphics(trackContext());
    this.arc = new Graphics(fillContext(0));
    this.addChild(this.track, this.arc);
  }

  /**
   * Per frame: size the hexagon at camera `zoom`, fill it to `pct`, and keep
   * it upright on screen whatever the host sprite's turn and build mirror.
   * The host is the structure sprite (`rotation`, `scale`); this hexagon's
   * parent (the hologram) adds no transform. Hidden once its on-screen
   * inscribed radius drops under `BUILD_RING_HIDE_PX`. No allocation after warm-up.
   */
  update(pct: number, zoom: number, host: Container): void {
    const step = buildRingStep(pct);
    if (step !== this.step) { this.step = step; this.arc.context = fillContext(step); }
    const hostScale = Math.abs(host.scale.y) || 1;
    const apothem = buildRingApothem(this.clearR, zoom);
    this.visible = !(zoom > 0) || apothem * zoom >= BUILD_RING_HIDE_PX;
    this.localR = apothem / HEX_APOTHEM_RATIO / hostScale;
    const k = this.localR / RING_UNIT;
    // Parent = R(rot)·S(m): the child R(-rot·m)·S(m) cancels it (setDeckSlot's rule).
    const m = host.scale.x < 0 ? -1 : 1;
    this.scale.set(m * k, k);
    this.rotation = -host.rotation * m;
  }
}
