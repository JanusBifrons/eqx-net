/**
 * Building panel camera nudge (building panels redesign, slice A5), the pure
 * maths: when a building's side panel opens it covers the right of the
 * screen, so the camera glides once to put the building in the middle of what
 * is left. The panel queues the target (`StructureSettingsModal` ->
 * `queuePanelNudge`); build mode's existing per-frame camera step fires it
 * through the existing `glideCameraTo` with the renderer feedback's scale.
 */
import type { SidePanelSize } from './SidePanel';

/** On-screen width (CSS px) of the right dock for `size`, as `rightPaperSx`
 *  lays it out: `width` (max 92vw) on desktop; on touch `touchFrac` of the
 *  screen clamped to [`touchMinW`, `width`]. */
export function rightPanelWidthPx(size: SidePanelSize, screenW: number, touch: boolean): number {
  const w = touch ? Math.min(size.width, Math.max(size.touchMinW, screenW * size.touchFrac)) : size.width;
  return Math.min(w, screenW * 0.92);
}

/** Camera centre X that puts `worldX` mid-way across the screen left of a
 *  `panelPx`-wide right panel at `scale` px per world unit (0 = unknown: no shift). */
export function panelNudgeX(worldX: number, panelPx: number, scale: number): number {
  return scale > 0 ? worldX + panelPx / 2 / scale : worldX;
}
