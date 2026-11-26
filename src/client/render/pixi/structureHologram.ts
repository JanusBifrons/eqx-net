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
 *
 * The PLACEMENT GHOST (the plan the player is positioning) is this same
 * hologram in its brighter `ghost` look: drawn once in white, then tinted
 * cyan (clear) or red (blocked by `placementRejection`) per frame, so a
 * valid/blocked switch recolours without rebuilding any art. No mask; the
 * print line sweeps across as a scanner and the plan pulses gently, both on
 * the game clock (`fxNow`).
 */
import { Container, Graphics, GraphicsContext } from 'pixi.js';
import type { StructureRenderState } from '../../../core/contracts/render/StructureRenderState.js';
import { buildStructureVisual } from './structureVisuals.js';
import { getStructureKind, isStructureKindId } from '../../../shared-types/structureKinds.js';
import { interpBuildPct } from './buildBarInterp.js';
import { CONNECTOR_CONSTRUCTION_COLOR, PREVIEW_BLOCKED_COLOR } from './connectorVisual.js';
import { deckSlotOutline, type DeckSlot } from '../../../core/hex/deckSnap.js';
import { BUILD_RING_LABEL, BuildRing } from './buildRing.js';

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
/** The placement ghost's tint where the server would refuse the plan (the
 *  build preview's red), and where it is clear (the hologram cyan). */
export const GHOST_BLOCKED_COLOR = PREVIEW_BLOCKED_COLOR;
export const GHOST_CLEAR_COLOR = HOLOGRAM_COLOR;
/** Ghost scanner sweep period and pulse period (game ms). */
const GHOST_SWEEP_MS = 1600;
const GHOST_PULSE_MS = 1200;

/** How a hologram is drawn. `blueprint` = an unbuilt structure's overlay
 *  (cyan baked in, faint panels: the solid art fills in behind it).
 *  `ghost` = the placement plan: white (tinted per frame), bright panels and
 *  thick edges so it reads on a phone at zoom ~0.5 over a busy sector.
 *  `wire` = the blueprint under `?buildRing=on` (readable construction): a
 *  dimmer ghost, thinner glass, near-empty panels, bold outlines and no scan
 *  lines (at build zoom the scan lines merged into a solid fill and the plan
 *  read as finished), drawn at `WIRE_ALPHA`. */
export type HoloLook = 'blueprint' | 'ghost' | 'wire';
interface LookSpec { color: number; core: number; backing: number; panel: number; edge: number; edgeW: number; scan: number; scanW: number }
const LOOKS: Record<HoloLook, LookSpec> = {
  blueprint: { color: HOLOGRAM_COLOR, core: 0xccffff, backing: 0.92, panel: 0.14, edge: 0.75, edgeW: 1, scan: 0.22, scanW: 1 },
  ghost: { color: 0xffffff, core: 0xffffff, backing: 0.92, panel: 0.32, edge: 1, edgeW: 3, scan: 0.5, scanW: 1.5 },
  wire: { color: HOLOGRAM_COLOR, core: 0xccffff, backing: 0.8, panel: 0.05, edge: 0.95, edgeW: 4, scan: 0, scanW: 0 },
};
/** The `wire` look's overall alpha (the solid art behind the print line is not dimmed). */
export const WIRE_ALPHA = 0.8;

interface HoloArt { art: GraphicsContext; line: GraphicsContext; mask: GraphicsContext; halfW: number; footR: number }
const artCache = new Map<string, HoloArt>();

/** The overlay's shared art for one kind + style (built once, never freed:
 *  one entry per structure kind at most). */
function holoArtFor(kindId: string | undefined, radius: number, style: string | undefined, look: HoloLook): HoloArt {
  const key = `${kindId ?? ''}|${style ?? ''}|${radius}|${look}`;
  const L = LOOKS[look];
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
  for (const r of plan.rects) art.rect(r.x, r.y, r.w, r.h).fill({ color: HOLOGRAM_BACKING, alpha: L.backing }).stroke({ color: HOLOGRAM_BACKING, alpha: L.backing, width: PAD });
  for (const p of plan.polys ?? []) art.poly(p.pts.flat()).fill({ color: HOLOGRAM_BACKING, alpha: L.backing }).stroke({ color: HOLOGRAM_BACKING, alpha: L.backing, width: PAD });
  // 2. Translucent cyan panels + wireframe edges.
  for (const r of plan.rects) art.rect(r.x, r.y, r.w, r.h).fill({ color: L.color, alpha: L.panel }).stroke({ color: L.color, alpha: L.edge, width: L.edgeW });
  for (const p of plan.polys ?? []) art.poly(p.pts.flat()).fill({ color: L.color, alpha: L.panel }).stroke({ color: L.color, alpha: L.edge, width: L.edgeW });
  // 3. Scan lines across the footprint.
  if (L.scan > 0) {
    for (let y = -halfH + SCAN_STEP / 2; y < halfH; y += SCAN_STEP) art.moveTo(-halfW, y).lineTo(halfW, y);
    art.stroke({ color: L.color, alpha: L.scan, width: L.scanW });
  }
  // The print line (at local x 0; moved per frame): a soft glow + a bright core.
  const line = new GraphicsContext()
    .rect(-3, -halfH - PAD, 6, 2 * (halfH + PAD)).fill({ color: L.color, alpha: 0.25 })
    .rect(-0.75, -halfH - PAD, 1.5, 2 * (halfH + PAD)).fill({ color: L.core, alpha: 0.95 });
  // A unit-wide mask strip from x 0 to 1 (scaled to "line .. right edge").
  const mask = new GraphicsContext().rect(0, -halfH - PAD, 1, 2 * (halfH + PAD)).fill({ color: 0xffffff });
  a = { art, line, mask, halfW, footR: Math.hypot(halfW, halfH) };
  artCache.set(key, a);
  return a;
}

/** Base platforms: the deck slot outline drawn under the placement ghost
 *  (white, tinted with the ghost). One shared context per slot shape, built
 *  once; Pixi space (game y flipped). */
const SLOT_OUTLINE_W = 8;
const slotArt = new Map<string, GraphicsContext>();
const SMALL_KEYS = ['small0', 'small1', 'small2'] as const;
function slotArtFor(slot: DeckSlot, rhombus: number): GraphicsContext {
  const key = slot === 'small' ? SMALL_KEYS[rhombus] ?? 'small0' : slot;
  let c = slotArt.get(key);
  if (c) return c;
  c = new GraphicsContext();
  for (const poly of deckSlotOutline(slot, rhombus)) {
    const pts: number[] = [];
    for (let i = 0; i < poly.length; i += 2) pts.push(poly[i]!, -poly[i + 1]!);
    c.poly(pts, true).fill({ color: 0xffffff, alpha: 0.06 }).stroke({ color: 0xffffff, alpha: 0.7, width: SLOT_OUTLINE_W });
  }
  slotArt.set(key, c);
  return c;
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
  /** The footprint's corner radius (the progress ring sits round it). */
  readonly footR: number;
  /** Build-fraction anchor: the fraction ramps smoothly between the server's
   *  1 Hz steps (`interpBuildPct`, the build bar's same ramp). */
  private anchorPct = -1;
  private anchorAtMs = 0;
  private anchorEtaMs: number | null = null;
  /** The fraction drawn last frame (tests read it). */
  shownPct = 0;

  constructor(kindId: string | undefined, radius: number, style: string | undefined, look: HoloLook = 'blueprint') {
    super();
    this.label = HOLOGRAM_LABEL;
    const a = holoArtFor(kindId, radius, style, look);
    this.halfW = a.halfW;
    this.footR = a.footR;
    if (look === 'wire') this.alpha = WIRE_ALPHA;
    this.ahead = new Graphics(a.art);
    this.clip = new Graphics(a.mask);
    this.line = new Graphics(a.line);
    if (look === 'ghost') {
      // The whole plan shows (nothing is paid yet); the line is a scanner.
      this.clip.visible = false;
      this.addChild(this.ahead, this.line);
    } else {
      this.ahead.mask = this.clip;
      this.addChild(this.ahead, this.clip, this.line);
    }
  }

  /** Per frame, the placement ghost only: tint cyan (clear) or red (blocked),
   *  sweep the scanner and pulse on the game clock. `sent` = the post-Confirm
   *  ghost awaiting the server: dimmer and still. No allocation. */
  updateGhost(blocked: boolean, sent: boolean, nowMs: number): void {
    this.tint = blocked ? GHOST_BLOCKED_COLOR : GHOST_CLEAR_COLOR;
    if (sent) { this.alpha = 0.45; this.line.visible = false; return; }
    const t = nowMs < 0 ? 0 : nowMs;
    this.line.visible = true;
    this.line.x = printLineX(this.halfW, (t % GHOST_SWEEP_MS) / GHOST_SWEEP_MS);
    this.alpha = 0.88 + 0.12 * Math.sin((t / GHOST_PULSE_MS) * 2 * Math.PI);
  }

  /** The deck slot outline (placement ghost on a deck room); made on first use. */
  private slot: Graphics | null = null;

  /** Per frame, the placement ghost only: show the deck slot it snapped to
   *  (null = no deck: hidden). The outline stays square to the deck, so it
   *  undoes this container's turn and build mirror. Call after setting them.
   *  No allocation after the first use of each slot shape. */
  setDeckSlot(slot: DeckSlot | null, rhombus: number): void {
    if (slot === null) { if (this.slot) this.slot.visible = false; return; }
    if (!this.slot) { this.slot = new Graphics(); this.addChildAt(this.slot, 0); }
    this.slot.context = slotArtFor(slot, rhombus);
    this.slot.visible = true;
    // Parent = R(rot)·S(m): the child R(-rot·m)·S(m) cancels it.
    const m = this.scale.x < 0 ? -1 : 1;
    this.slot.scale.x = m;
    this.slot.rotation = -this.rotation * m;
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

/** Out-param of the last `syncStructureHologram` call (scalar, reused: #14):
 *  the build-ETA label's sprite-local y just above the progress ring, or 0
 *  when no ring was drawn (the caller keeps the label's usual place). */
export const holoRingOut = { labelY: 0 };
/** On-screen gap (CSS px) between the ring and the ETA label above it. */
const RING_LABEL_GAP_PX = 4;

/**
 * Per frame, per structure sprite: an unbuilt structure carries the hologram
 * (made once on first sight), a built one carries none (dropped once).
 * `ringZoom` > 0 (`?buildRing=on`; the camera scale this frame) draws the
 * `wire` look plus a progress ring (buildRing.ts) at the hologram's smoothed
 * fraction; 0 = today's blueprint look, no ring.
 * Returns true while the sprite is a hologram.
 */
export function syncStructureHologram(
  sprite: Container, kindId: string | undefined, radius: number, style: string | undefined,
  st: StructureRenderState | undefined, nowMs: number, ringZoom = 0,
): boolean {
  holoRingOut.labelY = 0;
  let holo = sprite.getChildByLabel(HOLOGRAM_LABEL) as StructureHologram | null;
  if (st === undefined || st.built) {
    if (holo) { sprite.removeChild(holo); holo.destroy({ children: true }); }
    return false;
  }
  if (!holo) {
    holo = new StructureHologram(kindId, radius, style, ringZoom > 0 ? 'wire' : 'blueprint');
    if (ringZoom > 0) holo.addChild(new BuildRing());
    sprite.addChild(holo);
  }
  holo.update(st.buildPct, st.etaMs, nowMs);
  const ring = ringZoom > 0 ? holo.getChildByLabel(BUILD_RING_LABEL) as BuildRing | null : null;
  if (ring) {
    ring.update(holo.shownPct, holo.footR, ringZoom, sprite);
    holoRingOut.labelY = -(ring.localR + RING_LABEL_GAP_PX / (ringZoom * (Math.abs(sprite.scale.y) || 1)));
  }
  return true;
}
