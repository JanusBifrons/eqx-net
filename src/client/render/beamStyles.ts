/**
 * Named beam-pool styles (WS-4 Phase 4 follow-up). Hoisted out of
 * `PixiRenderer.init` so the deliberate visual DISTINCTION between the combat
 * laser beam and the Miner's drill beam is a greppable, unit-lockable contract
 * — not two inline literals a copy-paste could quietly equalise (which would
 * make the mining beam indistinguishable from a combat laser, defeating the
 * dedicated-pool point).
 *
 * Type-only import of `BeamSpriteStyle` keeps this module free of any Pixi
 * runtime dependency, so the lock test (`beamStyles.test.ts`) needs no renderer.
 */
import type { BeamSpriteStyle } from './BeamSpritePool.js';

/** Remote players' / drones' / turrets' combat hitscan beam — thin warm amber.
 *  `taper` (P3.13) — combat beams fade toward the tip of their range. */
export const REMOTE_BEAM_STYLE: BeamSpriteStyle = { tint: 0xffaa44, width: 2, alpha: 1, taper: true };

/** The Miner's mining (drill) beam — deliberately DISTINCT from the combat
 *  beam: a fatter, warmer amber at lower alpha so a player reads "mining laser",
 *  not "someone is shooting". */
export const MINING_BEAM_STYLE: BeamSpriteStyle = { tint: 0xffb24d, width: 3.5, alpha: 0.9 };

/**
 * The capital heavy beam's colour (plan beam-slices §8): a hot violet, distinct
 * from the amber fighter beams, the cyan own-ship beam and the amber drill. The
 * glow on a wreck's slice-cut edges reuses it, so a slice reads as "cut by that
 * beam" — import this, never re-type the literal.
 */
export const HEAVY_BEAM_COLOR = 0xb46cff;

/** Fewest screen px the heavy beam's core is drawn wide (`minScreenPx`): at
 *  capital zoom its 10 u core is under a px, thinner on screen than a fighter
 *  beam's glow; 12 px keeps it reading as the heaviest beam in the fight (6 px
 *  filmed as a laser pointer next to a 120 px hull). */
export const HEAVY_BEAM_MIN_SCREEN_PX = 12;

/** The capital heavy beam (`heavy_beam` mounts): a thick, capital-scale beam —
 *  core ~5× the fighter beam's width, tapering like every combat beam. Drawn by
 *  the SAME remote pool as fighter beams (a per-beam style override), in the
 *  pool's unfiltered `styledContainer`: the remote container's one orange glow
 *  filter would swamp the violet. The core is never under `minScreenPx` wide,
 *  so it reads heavier than a glowing fighter beam at capital zoom (where 10 u
 *  is under a px). `glowScale` widens the `?fx=new` halo / flow / flare. */
export const HEAVY_BEAM_STYLE: BeamSpriteStyle = {
  tint: HEAVY_BEAM_COLOR, width: 10, alpha: 1, taper: true, glowScale: 3, minScreenPx: HEAVY_BEAM_MIN_SCREEN_PX,
};

/** True when `mount` carries the capital heavy beam. */
export function isHeavyBeamMount(mount: { readonly weaponId: string } | null | undefined): boolean {
  return mount?.weaponId === 'heavy_beam';
}

/** The remote-pool style a beam from `mount` draws with: the heavy style for a
 *  `heavy_beam` mount, else `null` (the pool's own fighter style). The client
 *  resolves `mount` from the shooter's kind and `laser_fired.mountId`, so no
 *  wire change. */
export function remoteBeamStyleForMount(
  mount: { readonly weaponId: string } | null | undefined,
): BeamSpriteStyle | null {
  return isHeavyBeamMount(mount) ? HEAVY_BEAM_STYLE : null;
}

/** The mount `mountId` on a ship kind's catalogue `mounts` (alloc-free loop;
 *  `onMessage` / render paths, invariant #14), or null. */
export function findMount<M extends { readonly id: string }>(
  mounts: readonly M[] | undefined,
  mountId: string | undefined,
): M | null {
  if (!mounts || mountId === undefined) return null;
  for (let i = 0; i < mounts.length; i++) if (mounts[i]!.id === mountId) return mounts[i]!;
  return null;
}

/** A remote beam holds full brightness until this long before it expires,
 *  then fades (PixiRenderer's remote-laser loop). */
export const REMOTE_BEAM_FADE_MS = 150;

/**
 * How long a remote beam stays drawn after its last `laser_fired` (the TTL the
 * client stamps on the remote-laser entry). Player beams 400 ms, AI beams
 * 250 ms (see the `laser_fired` handler). The heavy beam fires every 10 ticks
 * (~167 ms); with the AI's 250 ms it would start fading 100 ms after each shot
 * and dip to ~55 % before the next one — a strobe. So it holds for the fade
 * window + a full cooldown + a snapshot-jitter margin: the next shot always
 * lands while the beam is still at full brightness, and it reads as one
 * continuous burn.
 */
export const HEAVY_BEAM_TTL_MS = 450;

export function remoteBeamTtlMs(isAiShooter: boolean, heavy: boolean): number {
  if (heavy) return HEAVY_BEAM_TTL_MS;
  return isAiShooter ? 250 : 400;
}
