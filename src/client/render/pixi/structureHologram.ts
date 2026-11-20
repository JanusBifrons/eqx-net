/**
 * Base loop 3O — an unbuilt structure (a blueprint) draws as a HOLOGRAM that
 * fills in as the base's mineral bank pays for it.
 *
 * The blueprint's own sprite (the restyle's style drawer, or its Machined
 * bake) is the SOLID art. On top of it this overlay draws the same plan in
 * construction cyan: a dark glass backing (so the solid art ahead of the
 * print line is hidden), translucent cyan panels, cyan wireframe edges and
 * scan lines. A cyan "print line" sweeps across the footprint (local x, left
 * to right) with the build fraction (`buildPct` = bank paid / cost, on the
 * wire already); the overlay is masked to the part AHEAD of the line, so
 * behind the line the real solid art shows.
 *
 * Perf (phone target, invariant #14): the overlay's art is a shared
 * `GraphicsContext` per (kind, style), built once; each blueprint owns three
 * tiny Graphics made once when it is first seen unbuilt. Per frame only the
 * mask's x/scale and the line's x move. The overlay is dropped once built.
 */
import { Container, Graphics, GraphicsContext } from 'pixi.js';
import type { StructureRenderState } from '../../../core/contracts/render/StructureRenderState.js';
import { buildStructureVisual } from './structureVisuals.js';
import { getStructureKind, isStructureKindId } from '../../../shared-types/structureKinds.js';
import { interpBuildPct } from './buildBarInterp.js';
import { CONNECTOR_CONSTRUCTION_COLOR } from './connectorVisual.js';

/** The hologram's cyan: the construction-flow cyan (connectors, build bar). */
export const HOLOGRAM_COLOR = CONNECTOR_CONSTRUCTION_COLOR;
/** Child label on the structure sprite. */
export const HOLOGRAM_LABEL = 'hologram';
/** Dark glass behind the cyan: hides the solid art ahead of the print line. */
const HOLOGRAM_BACKING = 0x04121a;
/** How far the backing / mask reach past the plan (covers a bake's rim). */
const PAD = 4;
/** Scan-line spacing (world units). */
const SCAN_STEP = 6;

interface HoloArt { art: GraphicsContext; line: GraphicsContext; mask: GraphicsContext; halfW: number }
const artCache = new Map<string, HoloArt>();

/** The overlay's shared art for one kind + style (built once, never freed:
 *  one entry per structure kind at most). */
function holoArtFor(kindId: string | undefined, radius: number, style: string | undefined): HoloArt {
  const key = `${kindId ?? ''}|${style ?? ''}|${radius}`;
  let a = artCache.get(key);
  if (a) return a;
  const kindless = !kindId || !isStructureKindId(kindId);
  const kind = getStructureKind(kindId);
  const plan = kindless
    ? buildStructureVisual('__kindless__', { accent: kind.color, seed: 1, size: { w: radius * 2, h: radius * 2 } })
    : buildStructureVisual(kind.id, { accent: kind.color, seed: 1, omitSpans: true, ...(style !== undefined ? { style } : {}) });
  const halfW = plan.footprint.w / 2, halfH = plan.footprint.h / 2;
  const art = new GraphicsContext();
  // 1. Dark glass backing over every shape (stroked wide to cover a bake's rim).
  for (const r of plan.rects) art.rect(r.x, r.y, r.w, r.h).fill({ color: HOLOGRAM_BACKING, alpha: 0.92 }).stroke({ color: HOLOGRAM_BACKING, alpha: 0.92, width: PAD });
  for (const p of plan.polys ?? []) art.poly(p.pts.flat()).fill({ color: HOLOGRAM_BACKING, alpha: 0.92 }).stroke({ color: HOLOGRAM_BACKING, alpha: 0.92, width: PAD });
  // 2. Translucent cyan panels + wireframe edges.
  for (const r of plan.rects) art.rect(r.x, r.y, r.w, r.h).fill({ color: HOLOGRAM_COLOR, alpha: 0.14 }).stroke({ color: HOLOGRAM_COLOR, alpha: 0.75, width: 1 });
  for (const p of plan.polys ?? []) art.poly(p.pts.flat()).fill({ color: HOLOGRAM_COLOR, alpha: 0.14 }).stroke({ color: HOLOGRAM_COLOR, alpha: 0.75, width: 1 });
  // 3. Scan lines across the footprint.
  for (let y = -halfH + SCAN_STEP / 2; y < halfH; y += SCAN_STEP) art.moveTo(-halfW, y).lineTo(halfW, y);
  art.stroke({ color: HOLOGRAM_COLOR, alpha: 0.22, width: 1 });
  // The print line (at local x 0; moved per frame): a soft glow + a bright core.
  const line = new GraphicsContext()
    .rect(-3, -halfH - PAD, 6, 2 * (halfH + PAD)).fill({ color: HOLOGRAM_COLOR, alpha: 0.25 })
    .rect(-0.75, -halfH - PAD, 1.5, 2 * (halfH + PAD)).fill({ color: 0xccffff, alpha: 0.95 });
  // A unit-wide mask strip from x 0 to 1 (scaled to "line .. right edge").
  const mask = new GraphicsContext().rect(0, -halfH - PAD, 1, 2 * (halfH + PAD)).fill({ color: 0xffffff });
  a = { art, line, mask, halfW };
  artCache.set(key, a);
  return a;
}

/** Local x of the print line for build fraction `pct` across a footprint of
 *  half-width `halfW`: 0 → the left edge, 0.5 → the middle, 1 → the right. */
export function printLineX(halfW: number, pct: number): number {
  const p = pct < 0 ? 0 : pct > 1 ? 1 : pct;
  return -halfW + 2 * halfW * p;
}

/** The overlay on one blueprint sprite (a child labelled `hologram`). */
export class StructureHologram extends Container {
  readonly ahead: Graphics;
  readonly line: Graphics;
  readonly clip: Graphics;
  readonly halfW: number;
  /** Build-fraction anchor: the fraction ramps smoothly between the server's
   *  1 Hz steps (`interpBuildPct`, the build bar's same ramp). */
  private anchorPct = -1;
  private anchorAtMs = 0;
  private anchorEtaMs: number | null = null;
  /** The fraction drawn last frame (tests read it). */
  shownPct = 0;

  constructor(kindId: string | undefined, radius: number, style: string | undefined) {
    super();
    this.label = HOLOGRAM_LABEL;
    const a = holoArtFor(kindId, radius, style);
    this.halfW = a.halfW;
    this.ahead = new Graphics(a.art);
    this.clip = new Graphics(a.mask);
    this.line = new Graphics(a.line);
    this.ahead.mask = this.clip;
    this.addChild(this.ahead, this.clip, this.line);
  }

  /** Per frame: place the print line and the mask for `buildPct`. No allocation. */
  update(buildPct: number, etaMs: number | null | undefined, nowMs: number): void {
    if (buildPct !== this.anchorPct) {
      this.anchorPct = buildPct;
      this.anchorAtMs = nowMs;
      this.anchorEtaMs = etaMs ?? null;
    }
    const pct = interpBuildPct(this.anchorPct, this.anchorEtaMs, nowMs - this.anchorAtMs);
    this.shownPct = pct;
    const x = printLineX(this.halfW, pct);
    this.line.x = x;
    this.clip.x = x;
    this.clip.scale.x = Math.max(1e-3, this.halfW + PAD - x);
    // Nothing paid yet: no line (all hologram). Fully paid: nothing ahead.
    this.line.visible = pct > 0 && pct < 1;
    this.ahead.visible = pct < 1;
  }
}

/**
 * Per frame, per structure sprite: an unbuilt structure carries the hologram
 * (made once on first sight), a built one carries none (dropped once).
 * Returns true while the sprite is a hologram.
 */
export function syncStructureHologram(
  sprite: Container, kindId: string | undefined, radius: number, style: string | undefined,
  st: StructureRenderState | undefined, nowMs: number,
): boolean {
  let holo = sprite.getChildByLabel(HOLOGRAM_LABEL) as StructureHologram | null;
  if (st === undefined || st.built) {
    if (holo) { sprite.removeChild(holo); holo.destroy({ children: true }); }
    return false;
  }
  if (!holo) { holo = new StructureHologram(kindId, radius, style); sprite.addChild(holo); }
  holo.update(st.buildPct, st.etaMs, nowMs);
  return true;
}
