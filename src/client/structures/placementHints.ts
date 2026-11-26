/**
 * The small warnings under the placement ghost, toggled each frame by direct
 * DOM writes (on change only, never a React re-render):
 *  - `placement-fence-hint`: a shield wall lies in a turret ghost's range
 *    (`turretFireCrossesWall`).
 *  - `placement-link-hint`: "Can't connect: too close" — the ghost would make
 *    no link and at least one was refused `'too-short'` (box edge to box edge under
 *    `MIN_CABLE_LENGTH`; owner rule "keep buildings apart"). The renderer's
 *    preview pass counts those (`RendererFeedback.placementPreviewTooShortCount`)
 *    with the same `canConnect` the server runs, and draws each one red.
 *    The same line instead says why the ghost can't go there at all (e.g.
 *    "Can't build here: blocked by an asteroid or wreck"): the renderer runs
 *    the server's `placementRejection` on the ghost and tints it red
 *    (`RendererFeedback.placementPreviewRejection`); the text is the server's
 *    own refusal notice. That reason wins over "too close".
 * Desktop and touch, under the ghost as one block (refusal line first, fence
 * line under it, never on top of each other), kept fully on screen and clear
 * of the HUD widgets (left strip, wallet pill, mode bar, right rail) using the
 * radar's measured HUD rects. Allocation-free.
 */
import type { RenderMirror } from '../../core/contracts/IRenderer.js';
import type { RendererFeedback } from '../../core/contracts/render/RendererFeedback.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { turretFireCrossesWall } from './fenceFireHint.js';
import { placementRejectionNotice } from '../../core/structures/placementRules.js';
import { EMPTY_RADAR_INSETS, type RadarInsets } from '../../shared-types/settings/radar.js';

/** The player-facing line for a placement whose only links are too short. */
export const TOO_CLOSE_LINK_TEXT = "Can't connect: too close";

/** Show the too-close line: a link was refused as too short and none forms. */
export function showTooCloseHint(connCount: number, tooShortCount: number): boolean {
  return tooShortCount > 0 && connCount === 0;
}

type HintFeedback = Pick<RendererFeedback, 'placementPreviewConnectionCount' | 'placementPreviewTooShortCount' | 'placementPreviewRejection' | 'viewHalf'>;

/** Gap (screen px) between the ghost's edge and the too-close line. */
const BELOW_GHOST_PX = 10;

/** Screen px from the ghost's centre down past its edge: half its footprint's
 *  longer side (any rotation) at the camera's scale (`viewHalf` = the larger
 *  half of the visible world, along the window's larger side), plus a gap.
 *  0 scale (before the first frame) ⇒ just the gap. Alloc-free. */
export function belowGhostPx(kind: string | null, viewHalf: number, winW: number, winH: number): number {
  if (kind === null || !(viewHalf > 0)) return BELOW_GHOST_PX;
  const { w, h } = getStructureKind(kind).footprint;
  return (Math.max(w, h) / 2) * (Math.max(winW, winH) / 2 / viewHalf) + BELOW_GHOST_PX;
}

/** Screen px kept between the hint block and the screen edge. */
const EDGE_PX = 8;
/** Screen px between the two hint lines, and between the block and a HUD widget. */
const GAP_PX = 4;

/** The HUD rects the hints keep clear of: the radar's measured insets
 *  (`measureRadarInsets`, 2 Hz in App.tsx: every slot-host widget and
 *  `data-hud-exclusion` element, plus the right rail and app bar). */
let _hud: RadarInsets = EMPTY_RADAR_INSETS;
export function setPlacementHudInsets(insets: RadarInsets): void { _hud = insets; }

/** Result scratch of {@link fitHintBlock} (top-left of the block). */
export const hintFit = { x: 0, y: 0 };

/** Pure, alloc-free: place a `w`×`h` block centred on `cx` with its top at
 *  `top`, then keep it fully on screen (inside the HUD's edge insets) and push
 *  it out of every HUD rect it overlaps by the shortest in-bounds move.
 *  Writes {@link hintFit}. */
export function fitHintBlock(cx: number, top: number, w: number, h: number, vw: number, vh: number, hud: RadarInsets): void {
  const minX = hud.left + EDGE_PX; const maxX = vw - hud.right - EDGE_PX - w;
  const minY = hud.top + EDGE_PX; const maxY = vh - hud.bottom - EDGE_PX - h;
  let x = Math.max(minX, Math.min(maxX, cx - w / 2));
  let y = Math.max(minY, Math.min(maxY, top));
  const ex = hud.exclusions;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (let i = 0; i < ex.length; i++) {
      const r = ex[i]!;
      if (x >= r.x + r.w + GAP_PX || x + w <= r.x - GAP_PX || y >= r.y + r.h + GAP_PX || y + h <= r.y - GAP_PX) continue;
      let best = Infinity; let bx = x; let by = y;
      const right = r.x + r.w + GAP_PX;
      if (right <= maxX && right - x < best) { best = right - x; bx = right; by = y; }
      const left = r.x - GAP_PX - w;
      if (left >= minX && x - left < best) { best = x - left; bx = left; by = y; }
      const up = r.y - GAP_PX - h;
      if (up >= minY && y - up < best) { best = y - up; bx = x; by = up; }
      const down = r.y + r.h + GAP_PX;
      if (down <= maxY && down - y < best) { best = down - y; bx = x; by = down; }
      if (best === Infinity) continue;
      x = bx; y = by; moved = true;
    }
    if (!moved) break;
  }
  hintFit.x = x; hintFit.y = y;
}

/** Per-hint cache: measured size (re-read on show / text change) and the
 *  last written position (styles written on change only). */
interface HintBox { w: number; h: number; stale: boolean; left: number; top: number }
const _link: HintBox = { w: 0, h: 0, stale: true, left: NaN, top: NaN };
const _fence: HintBox = { w: 0, h: 0, stale: true, left: NaN, top: NaN };

/** Show / hide `el` (on change only); measure it once when it appears or its text changed. */
function toggleHint(el: HTMLElement | null, show: boolean, box: HintBox): void {
  if (!el) return;
  if (el.hidden === show) {
    el.hidden = !show;
    box.stale = true; box.left = NaN; box.top = NaN;
  }
  if (show && box.stale) { box.w = el.offsetWidth; box.h = el.offsetHeight; box.stale = false; }
}

function placeHint(el: HTMLElement, box: HintBox, cx: number, top: number): void {
  const l = Math.round(cx); const t = Math.round(top);
  if (l !== box.left) { box.left = l; el.style.left = `${l}px`; }
  if (t !== box.top) { box.top = t; el.style.top = `${t}px`; }
}

/** Per-frame (while placing): update both ghost hints. `kind` is the ghost's
 *  kind, (`x`, `y`) its world point, (`psx`, `psy`) its screen point. The two
 *  lines form one block under the ghost (the refusal / too-close line first,
 *  the fence line under it), fitted on screen and clear of the HUD as one. */
export function updatePlacementHints(
  feedback: HintFeedback, psx: unknown, psy: unknown, kind: string | null, x: number, y: number,
  mirror: Pick<RenderMirror, 'structures' | 'swarm'>,
): void {
  const fence = document.querySelector('[data-testid="placement-fence-hint"]') as HTMLElement | null;
  const showFence = fence !== null && kind !== null && turretFireCrossesWall(kind, x, y, mirror.structures, mirror.swarm);
  toggleHint(fence, showFence, _fence);
  const link = document.querySelector('[data-testid="placement-link-hint"]') as HTMLElement | null;
  const rejection = feedback.placementPreviewRejection ?? null;
  const showLink = link !== null && (rejection !== null || showTooCloseHint(feedback.placementPreviewConnectionCount, feedback.placementPreviewTooShortCount));
  if (link && showLink) {
    // The text node (the hint's Typography, or the element itself): written on change only.
    const textEl = link.firstElementChild ?? link;
    const text = rejection !== null ? placementRejectionNotice(rejection) : TOO_CLOSE_LINK_TEXT;
    if (textEl.textContent !== text) { textEl.textContent = text; _link.stale = true; }
  }
  toggleHint(link, showLink, _link);
  if ((!showLink && !showFence) || typeof psx !== 'number' || typeof psy !== 'number') return;
  const vw = window.innerWidth; const vh = window.innerHeight;
  const w = Math.max(showLink ? _link.w : 0, showFence ? _fence.w : 0);
  const linkH = showLink ? _link.h + (showFence ? GAP_PX : 0) : 0;
  fitHintBlock(psx, psy + belowGhostPx(kind, feedback.viewHalf, vw, vh), w, linkH + (showFence ? _fence.h : 0), vw, vh, _hud);
  const cx = hintFit.x + w / 2;
  if (link && showLink) placeHint(link, _link, cx, hintFit.y);
  if (fence && showFence) placeHint(fence, _fence, cx, hintFit.y + linkH);
}
