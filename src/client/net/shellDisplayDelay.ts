/**
 * The display delay drawn shells read (netcode gap smoothing S5-6a).
 *
 * Shells are placed in closed form at a display tick on the GAME clock
 * (`updateProjectilesMirror`): server-tick estimate minus this delay. They
 * read the drone delay BEFORE the stream-stall hold
 * (`getSwarmSteadyDisplayDelayMs`, slewed toward the same target on the same
 * frame step as the held one), so in steady play a shell is drawn at the same
 * lateness as the drones it flies between, and through a drone stream stall
 * it keeps flying: a shell's path is known in closed form, so it never needs
 * the hold (feeding it the held value froze shells for up to 15 frames).
 * That value is WALL ms; the display tick is game time, so it is multiplied
 * by the time scale here (the drone floor is 100 / speed wall ms, so on a
 * clean link this is exactly the old 100 game ms at any speed).
 *
 * Fallback for a NaN / zero / non-finite input: the old fixed delay, already
 * in game ms.
 */
import { DISPLAY_DELAY_MS } from './swarmDelaySizing.js';

/** Fallback shell display delay, GAME ms (the drone delay floor at 1×). */
export const SHELL_DISPLAY_DELAY_MS = DISPLAY_DELAY_MS;

/**
 * The shell display delay for this frame, in GAME ms.
 * @param steadyWallMs the drone delay before the stall hold (wall ms).
 * @param timeScale the game clock's speed (game ms per wall ms).
 */
export function shellDisplayDelayGameMs(steadyWallMs: number | undefined, timeScale: number): number {
  if (steadyWallMs !== undefined && steadyWallMs > 0 && Number.isFinite(steadyWallMs)) {
    return steadyWallMs * timeScale;
  }
  return SHELL_DISPLAY_DELAY_MS;
}
