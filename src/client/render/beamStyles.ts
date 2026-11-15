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
import { HEAVY_BEAM_WIDTH } from '../../core/combat/WeaponCatalogue.js';

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
 *  core `HEAVY_BEAM_WIDTH` wide, the width of the strip its slice erases on a
 *  kill. It does NOT taper: full width and brightness all the way to its hit
 *  point (filmed review 2026-11-15: on the fighter taper gradient it thinned
 *  and dimmed over its last third, right at the impact); only a miss fades,
 *  over its last `HEAVY_BEAM_MISS_FADE_FRAC` (`remoteBeamSolidLen`). Drawn by
 *  the SAME remote pool as fighter beams (a per-beam style override), in the
 *  pool's unfiltered `styledContainer`: the remote container's one orange glow
 *  filter would swamp the violet. The core is never under `minScreenPx` wide,
 *  so it reads heavier than a glowing fighter beam at capital zoom (where even
 *  60 u can be only a few px). `glowScale` widens the `?fx=new` halo / flow / flare. */
export const HEAVY_BEAM_STYLE: BeamSpriteStyle = {
  tint: HEAVY_BEAM_COLOR, width: HEAVY_BEAM_WIDTH, alpha: 1, taper: false, glowScale: 3, minScreenPx: HEAVY_BEAM_MIN_SCREEN_PX,
};

/** A heavy beam that MISSES fades over this last share of its drawn length
 *  (to its max range); one that hits is solid to the hit point. */
export const HEAVY_BEAM_MISS_FADE_FRAC = 0.15;

/** The solid length (`BeamView.solidLen`) a remote beam of `style` draws
 *  with over `len` world units: a non-tapering style (the heavy beam) is
 *  solid to its end on a hit, and fades only over its last
 *  `HEAVY_BEAM_MISS_FADE_FRAC` on a miss; anything else (null: the fighter
 *  pool style, or a tapering style) is undefined, the pool's own taper. */
export function remoteBeamSolidLen(style: BeamSpriteStyle | null, len: number, hit: boolean): number | undefined {
  if (style === null || style.taper) return undefined;
  return hit ? len : len * (1 - HEAVY_BEAM_MISS_FADE_FRAC);
}

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

/**
 * The fire angle a remote beam is drawn along (PixiRenderer's remote-laser
 * loop): the shooter's live hull angle + the mount's base angle + the turret's
 * slewed angle, so the beam leaves down the drawn barrel.
 *
 * With no turret angle known (`mountAngle` undefined) it aims from the beam's
 * live origin at the wire end point (`laser_fired.to`) instead. Turret angles
 * ride `snapshot.drones[].mountAngles` only for drones in the viewer's
 * interest window, which scales with the viewer's hull: a capital burning a
 * frigate from 8 km is outside the frigate's window, and an angle defaulted
 * to 0 sent the beam along the mount's base bearing, off screen.
 */
export function remoteBeamFireAngle(
  poseAngle: number, baseAngle: number, mountAngle: number | undefined,
  originX: number, originY: number, toX: number, toY: number,
): number {
  if (mountAngle !== undefined) return poseAngle + baseAngle + mountAngle;
  const dx = toX - originX, dy = toY - originY;
  if (dx === 0 && dy === 0) return poseAngle + baseAngle;
  // Game-space forward is (-sin a, cos a).
  return Math.atan2(-dx, dy);
}

/** A drawn remote beam line (game space), filled by `remoteBeamLine`. */
export interface RemoteBeamLine { fromX: number; fromY: number; toX: number; toY: number }

/**
 * The line a remote beam is drawn along this frame (game space), into `out`
 * (no allocation, #14). `pivotX/Y` is the mount's live pivot on the shooter's
 * drawn hull, `muzzleD` the barrel length, `range` the wire beam's length and
 * `wireToX/Y` its end point (`laser_fired.to`: where the server's ray stopped).
 *
 * `holdLine` false (fighter beams): the beam leaves down the live barrel
 * (`remoteBeamFireAngle`) for `range`. Their 250 ms life overlaps a 167 ms
 * cooldown, so a fresh pulse redraws the line every shot; a nose gun's beam
 * that stayed put while the fighter turned would leave its nose.
 *
 * `holdLine` true (a styled beam: the capital heavy beam): a pulse stays on
 * the line it was fired along for its whole `HEAVY_BEAM_TTL_MS` life. Its
 * origin follows the muzzle (the ship moves under it), but it aims at the
 * wire end point and stops THERE: never the live mount angle. A heavy pulse
 * outlives a cooldown by ~280 ms, so drawing it down the live barrel swung
 * the last pulse with the turret after the kill follow-through (filmed: ~1.9°
 * off the cut in 0.33 s, then sweeping past the wreck) and, while the turret
 * was still swinging onto a target, ran the beam through the intact hull to
 * its full range.
 */
export function remoteBeamLine(
  holdLine: boolean, poseAngle: number, baseAngle: number, mountAngle: number | undefined,
  pivotX: number, pivotY: number, muzzleD: number, range: number,
  wireToX: number, wireToY: number, out: RemoteBeamLine,
): RemoteBeamLine {
  const a = remoteBeamFireAngle(poseAngle, baseAngle, holdLine ? undefined : mountAngle, pivotX, pivotY, wireToX, wireToY);
  const fx = -Math.sin(a), fy = Math.cos(a);
  out.fromX = pivotX + fx * muzzleD;
  out.fromY = pivotY + fy * muzzleD;
  if (holdLine) {
    // The end point is the server's: a hit stays on the hit. An end point
    // inside the barrel (point blank) draws nothing rather than backwards.
    const behind = (wireToX - pivotX) * fx + (wireToY - pivotY) * fy <= muzzleD;
    out.toX = behind ? out.fromX : wireToX;
    out.toY = behind ? out.fromY : wireToY;
  } else {
    out.toX = out.fromX + fx * range;
    out.toY = out.fromY + fy * range;
  }
  return out;
}

/** Where `addBeamLights` puts its lights (`LitScene.addLight`'s shape). */
export interface BeamLightSink {
  addLight(x: number, y: number, z: number, color: number, intensity: number, reach: number): void;
}

/**
 * A beam lights where it hits and along its length (the GPU-lit art). The
 * beam is in GAME space and the lit scene in PIXI space (y down: pixiY =
 * -gameY, like every other light the renderer feeds it). Without the flip the
 * lights sat at the beam's Y mirror: a heavy beam burning a cruiser 280 u
 * below the sector's x axis lit a spot 560 u up its hull (a hard rose wash on
 * the wreck piece there that vanished with the beam) and never the piece it
 * hit. A styled (heavy) beam lights in its own colour, `glowScale` wider.
 */
export function addBeamLights(
  sink: BeamLightSink,
  b: { fromX: number; fromY: number; toX: number; toY: number; style?: { tint: number; glowScale?: number } | null },
): void {
  const len = Math.hypot(b.toX - b.fromX, b.toY - b.fromY);
  const c = b.style ? b.style.tint : 0xff6a9a;
  const k = b.style?.glowScale ?? 1;
  sink.addLight(b.toX, -b.toY, 6, c, 2.2, 120 * k);
  sink.addLight((b.fromX + b.toX) / 2, -(b.fromY + b.toY) / 2, 6, c, 0.8, len * 0.6 + 30 * k);
}
