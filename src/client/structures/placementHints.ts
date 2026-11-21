/**
 * The small warnings under the placement ghost, toggled each frame by direct
 * DOM writes (on change only, never a React re-render):
 *  - `placement-fence-hint`: a shield wall lies in a turret ghost's range
 *    (`turretFireCrossesWall`).
 *  - `placement-link-hint`: "Can't connect: too close" — the ghost would make
 *    no link and at least one was refused `'too-short'` (stud to stud under
 *    `MIN_CABLE_LENGTH`; owner rule "keep buildings apart"). The renderer's
 *    preview pass counts those (`RendererFeedback.placementPreviewTooShortCount`)
 *    with the same `canConnect` the server runs, and draws each one red.
 *    The same line instead says why the ghost can't go there at all (e.g.
 *    "Can't build here: blocked by an asteroid or wreck"): the renderer runs
 *    the server's `placementRejection` on the ghost and tints it red
 *    (`RendererFeedback.placementPreviewRejection`); the text is the server's
 *    own refusal notice. That reason wins over "too close".
 * Desktop and touch; a hint docked in the touch banner (`data-docked`) is
 * shown/hidden only, never moved. Allocation-free.
 */
import type { RenderMirror } from '../../core/contracts/IRenderer.js';
import type { RendererFeedback } from '../../core/contracts/render/RendererFeedback.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { turretFireCrossesWall } from './fenceFireHint.js';
import { placementRejectionNotice } from '../../core/structures/placementRules.js';

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

/** Show / hide `el` (on change only) and anchor it under the ghost. */
function toggleHint(el: HTMLElement | null, show: boolean, psx: unknown, psy: unknown, dy = 0): void {
  if (!el) return;
  if (el.hidden === show) el.hidden = !show;
  if (show && el.dataset.docked !== '1' && typeof psx === 'number' && typeof psy === 'number') {
    el.style.left = `${Math.max(8, Math.min(window.innerWidth - 8, psx))}px`;
    el.style.top = `${Math.max(48, Math.min(window.innerHeight - 40, psy + dy))}px`;
  }
}

/** Per-frame (while placing): update both ghost hints. `kind` is the ghost's
 *  kind, (`x`, `y`) its world point, (`psx`, `psy`) its screen point. */
export function updatePlacementHints(
  feedback: HintFeedback, psx: unknown, psy: unknown, kind: string | null, x: number, y: number,
  mirror: Pick<RenderMirror, 'structures' | 'swarm'>,
): void {
  const fence = document.querySelector('[data-testid="placement-fence-hint"]') as HTMLElement | null;
  if (fence) toggleHint(fence, kind !== null && turretFireCrossesWall(kind, x, y, mirror.structures, mirror.swarm), psx, psy);
  const link = document.querySelector('[data-testid="placement-link-hint"]') as HTMLElement | null;
  const rejection = feedback.placementPreviewRejection ?? null;
  const showLink = rejection !== null || showTooCloseHint(feedback.placementPreviewConnectionCount, feedback.placementPreviewTooShortCount);
  if (link && showLink) {
    // The text node (the hint's Typography, or the element itself): written on change only.
    const textEl = link.firstElementChild ?? link;
    const text = rejection !== null ? placementRejectionNotice(rejection) : TOO_CLOSE_LINK_TEXT;
    if (textEl.textContent !== text) textEl.textContent = text;
  }
  toggleHint(link, showLink, psx, psy, showLink ? belowGhostPx(kind, feedback.viewHalf, window.innerWidth, window.innerHeight) : 0);
}
