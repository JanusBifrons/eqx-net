/**
 * Which ships `PixiRenderer.drawWarpFx` feeds to the warp effects (WarpFx +
 * the spool glow). Pure (tests).
 *
 * An active ship is fed every frame. A parked / AI-flown hull (#17 LINGERING)
 * is fed only while it carries a warp phase (RTS fleet warp S4: 1 while its
 * fleet group spools, 3 just after it was handed in), plus ONE frame after
 * the phase clears, so a cancelled spool settles to idle instead of WarpFx
 * reading the hull's absence from the feed as a departure (the same rule as
 * a warping NPC). A hull that vanishes WHILE spooling is fed no more, so
 * WarpFx draws its departure flash where it stood.
 */
export function warpFxFeedsShip(parkedHull: boolean, warp: number | undefined, fedLastFrame: boolean): boolean {
  return !parkedHull || warp !== undefined || fedLastFrame;
}
