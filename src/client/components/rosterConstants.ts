/** Per-player roster cap. Mirror of `ROSTER_CAP` in
 *  `src/server/playerShips/PlayerShipStore.ts`. The client never imports
 *  from `src/server/**` (CI invariant), so this small constant lives
 *  separately. Bump both sides together if the cap ever changes. */
export const ROSTER_CAP = 10;

/** Grid cell size in world units for the HUD coordinate readout. Mirror
 *  of the `CELL_SIZE` constant in `src/client/render/BackgroundGrid.ts`.
 *  Used by `ShipRosterCard` to display `(gx, gy)` for stored ships. */
export const GRID_CELL = 500;
