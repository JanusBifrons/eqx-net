/**
 * Production channel for the pointer-chosen structure-placement world point.
 *
 * WHY THIS EXISTS (smoke 2026-06-07, capture `kuytvy`): the Confirm banner used
 * to read the chosen point from `data-placement-world-x/y` on the game-surface
 * element. But that ENTIRE dataset surface is gated behind `navigator.webdriver`
 * (E2E-only — see `gameRafLoop`'s `writeE2E`), so on a REAL phone it is never
 * written and Confirm always fell back to ahead-of-ship (`hasChosen:false` in
 * the capture). Playwright sets `navigator.webdriver=true`, so the E2E exercised
 * a channel no player ever has — green test, broken production.
 *
 * This module is the production-safe replacement: `gameRafLoop` writes it every
 * frame WHILE A BLUEPRINT GHOST IS UP (un-gated), the banner reads it on
 * Confirm. It is a plain module singleton — NOT Zustand (invariant #2 forbids
 * spatial fields in the store) and NOT the DOM dataset (E2E-gated). Mutated in
 * place to avoid per-frame allocation (#14).
 *
 * It also carries the ghost's VERDICT (`rejection`: the server's own
 * `placementRejection` at the drawn pose, from
 * `RendererFeedback.placementPreviewRejection`), so the commit path never
 * sends a placement the server would refuse (#15) and the Confirm button can
 * disable itself (it subscribes; a change notifies, a steady value does not).
 */
import type { RendererFeedback } from '../../core/contracts/IRenderer.js';
import type { PlacementRejection } from '../../core/structures/placementRules.js';

export interface PlacementChosen {
  /** Chosen world X (game-space), or null until the player positions the ghost. */
  worldX: number | null;
  worldY: number | null;
  /** True once the ghost is parked (pointer released). */
  stuck: boolean;
  /** Why the server would refuse the ghost where it is drawn, or null when clear. */
  rejection: PlacementRejection | null;
}

export const placementChosen: PlacementChosen = {
  worldX: null,
  worldY: null,
  stuck: false,
  rejection: null,
};

const rejectionListeners = new Set<() => void>();

/** Set the ghost's verdict; listeners hear only a change. */
export function setPlacementRejection(r: PlacementRejection | null): void {
  if (placementChosen.rejection === r) return;
  placementChosen.rejection = r;
  for (const l of rejectionListeners) l();
}

/** `useSyncExternalStore` pair for the ghost's verdict (the Confirm button). */
export function subscribePlacementRejection(l: () => void): () => void {
  rejectionListeners.add(l);
  return () => { rejectionListeners.delete(l); };
}
export function getPlacementRejection(): PlacementRejection | null {
  return placementChosen.rejection;
}

/** Per frame while a ghost is up: copy the renderer's chosen point, park
 *  state and verdict. Allocation-free. */
export function writePlacementChosen(
  feedback: Pick<RendererFeedback, 'placementChosenWorldX' | 'placementChosenWorldY' | 'placementStuck' | 'placementPreviewRejection'>,
): void {
  placementChosen.worldX = typeof feedback.placementChosenWorldX === 'number' ? feedback.placementChosenWorldX : null;
  placementChosen.worldY = typeof feedback.placementChosenWorldY === 'number' ? feedback.placementChosenWorldY : null;
  placementChosen.stuck = feedback.placementStuck;
  setPlacementRejection(feedback.placementPreviewRejection ?? null);
}

/** Clear the chosen point (placement ended / cancelled). */
export function resetPlacementChosen(): void {
  placementChosen.worldX = null;
  placementChosen.worldY = null;
  placementChosen.stuck = false;
  setPlacementRejection(null);
}
