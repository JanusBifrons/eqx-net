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
 */
export interface PlacementChosen {
  /** Chosen world X (game-space), or null until the player positions the ghost. */
  worldX: number | null;
  worldY: number | null;
  /** True once the ghost is parked (pointer released). */
  stuck: boolean;
}

export const placementChosen: PlacementChosen = {
  worldX: null,
  worldY: null,
  stuck: false,
};

/** Clear the chosen point (placement ended / cancelled). */
export function resetPlacementChosen(): void {
  placementChosen.worldX = null;
  placementChosen.worldY = null;
  placementChosen.stuck = false;
}
