/**
 * Local-player hitscan beam visual decision (pure; the side-effecting
 * `ColyseusClient.sendFire` / renderer defer to these — the
 * `shouldDetachWarpVisual` precedent).
 *
 * Background: see `LocalBeam.test.ts` and diagnostic capture
 * `2026-05-19T10-55-36-274Z-pe6rdt`. The local hitscan beam used to be
 * drawn as a continuous ship-attached beam PLUS a redundant chain of
 * "ghost" segments frozen at the `predWorld` pose sampled in `sendFire`;
 * the frozen layer detached from the ship under lag/reconcile correction.
 */
import type { WeaponMode } from '@core/combat/WeaponCatalogue';
import type { SwarmRenderState } from '@core/contracts/IRenderer';
import type { InterpolatedPose } from '../net/swarmInterpolation';
import { resolveEntityDisplayPose } from '../net/swarmDisplayPose';

/**
 * Should a LOCAL-player fire of this weapon mode spawn a travelling ghost
 * projectile?
 *
 *  - Hitscan → **false**. The local hitscan beam is drawn continuously
 *    from the ship's RENDERED pose (`mirror.ships`) every frame, so it is
 *    rigidly ship-attached and server lag/correction is invisible. A
 *    ghost is frozen at the `predWorld` pose sampled inside `sendFire`
 *    (a different sample than the ship sprite — capture-`pe6rdt`), so it
 *    is a redundant second layer that visibly detaches under lag.
 *    Dropping it leaves exactly one, attached, beam.
 *  - Projectile → **true**. The bolt actually travels; the moving ghost
 *    IS the visual and there is no continuous beam for it to attach to.
 */
export function localFireSpawnsGhost(mode: WeaponMode): boolean {
  return mode !== 'hitscan';
}

/**
 * How long the continuous local hitscan beam stays drawn after the last
 * fire tick. Must be ≥ the hitscan inter-shot interval (`cooldownTicks /
 * 60 s` ≈ 167 ms) so a held burst never blinks off between shots — the
 * gap the frozen ghost layer used to paper over. Kept small so a single
 * tap does not leave a beam lingering unnaturally. Locked against the
 * catalogue cooldown by `LocalBeam.test.ts`.
 */
export const LIVE_BEAM_PERSIST_MS = 220;

/**
 * Is the local hitscan beam still within its post-fire persistence
 * window? `lastFireMs === null` ⇒ never fired ⇒ not visible. The window
 * is inclusive of the boundary. Time is injected (no `performance.now()`
 * here) so the lifecycle is deterministically testable.
 */
export function liveBeamVisible(nowMs: number, lastFireMs: number | null, persistMs: number): boolean {
  return lastFireMs !== null && nowMs - lastFireMs <= persistMs;
}

/** A turret auto-aim candidate, in the SAME pose the drone is drawn at. */
export interface LocalAimTarget {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Whether this drone is currently hostile to the local player (mirror of
   *  `SwarmRenderState.isHostileToLocal`, last computed in `updateMirror`).
   *  Auto-fire engages ONLY hostiles; carrying the flag here lets the
   *  fire-decision scan stay allocation-free (no ledger lookup / id parsing
   *  per candidate — invariant #14). Named `hostile` to match
   *  `MountTargetView.hostile` so the turret-aim `pickTarget` reads it directly
   *  (Part C — hostile-only player aim, alloc-free single-viewer path). */
  hostile: boolean;
  /** Hull health fraction (0..1) of this drone, from `SwarmRenderState.healthFrac`
   *  (absent ⇒ 1/full). With `maxHealth: 1` this feeds `pickTarget`'s
   *  `healthWeight` so the turret + auto-fire prefer the wounded (Part C). */
  health: number;
  maxHealth: number;
}

/**
 * Build the local turret's auto-aim candidate list from the swarm mirror.
 *
 * Each drone's aim position is read from the SINGLE per-frame display
 * pose that `ColyseusClient.updateMirror` already resolved (one
 * `interpolateSwarmPose` call per frame, written into `entry.x/y/angle`,
 * and the pose the predWorld collision body + sprite + laser beam all
 * use) — via `resolveEntityDisplayPose`. It does **not** re-interpolate.
 *
 * Why this matters (drone/laser-jitter fix, 2026-05-19; supersedes the
 * `0e24448` mechanism, same goal): `buildLocalAimTargets` runs in
 * `tickPhysics`, *earlier* in the frame than `updateMirror` and the
 * renderer. If it called `interpolateSwarmPose` itself it resolved the
 * pose at a DIFFERENT `now` than the frame's single resolution — by a
 * variable, raf-jitter-amplified amount — so the turret aimed at one
 * pose while the sprite was drawn at another and the beam jittered
 * against the drone ("two things fighting"; on-device, capture
 * `…-jfagww`). Reading the one written pose makes "aim == draw ==
 * collide" true by construction, with at most a smooth ≤1-frame
 * lead-lag (the accepted "render the past"), never per-frame jitter.
 * `0e24448`'s guarantee — aim the DRAWN pose, not the raw/ahead
 * authoritative one — is preserved: `updateMirror` wrote the
 * display-delayed interpolated pose into `entry.x/y`, so that is what
 * is read here.
 *
 * Asteroids (`kind !== 1`) are never turret targets. Returns a fresh
 * array (caller scope = once per `tickLocalMountAim`; the per-candidate
 * object cost is unchanged from the prior inline construction).
 */
export function buildLocalAimTargets(
  swarm: ReadonlyMap<number, SwarmRenderState>,
  scratch: InterpolatedPose,
): LocalAimTarget[] {
  const out: LocalAimTarget[] = [];
  for (const [entityId, sw] of swarm) {
    if (sw.kind !== 1) continue; // asteroids aren't valid targets
    resolveEntityDisplayPose(sw, scratch);
    out.push({
      id: `swarm-${entityId}`,
      x: scratch.x,
      y: scratch.y,
      vx: sw.vx,
      vy: sw.vy,
      hostile: sw.isHostileToLocal ?? false,
      health: sw.healthFrac ?? 1,
      maxHealth: 1,
    });
  }
  return out;
}
