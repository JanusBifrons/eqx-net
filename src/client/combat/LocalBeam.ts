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
import { interpolateSwarmPose, type InterpolatedPose } from '../net/swarmInterpolation';

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
}

/**
 * Build the local turret's auto-aim candidate list from the swarm mirror.
 *
 * Each drone's aim position is resolved through the SAME
 * `interpolateSwarmPose` (display-delay buffer) that the renderer and the
 * predWorld kinematic follower use — NOT the raw `entry.x/y`. That raw
 * field holds the latest AUTHORITATIVE decoded pose (the binary decoder
 * writes it ~20 Hz; `updateMirror` only overwrites it with the
 * interpolated pose later in the frame), so reading it from
 * `tickLocalMountAim` (which runs earlier, in `tickPhysics`) made the
 * turret aim at where the drone *is* on the wire — ~100 ms / its
 * dead-reckoned lead ahead of where the sprite is DRAWN. Resolving the
 * pose here makes "aim == draw == collide" true by construction,
 * independent of packet / `updateMirror` ordering.
 *
 * Asteroids (`kind !== 1`) are never turret targets. Returns a fresh
 * array (caller scope = once per `tickLocalMountAim`; the per-candidate
 * object cost is unchanged from the prior inline construction).
 */
export function buildLocalAimTargets(
  swarm: ReadonlyMap<number, SwarmRenderState>,
  nowMs: number,
  scratch: InterpolatedPose,
): LocalAimTarget[] {
  const out: LocalAimTarget[] = [];
  for (const [entityId, sw] of swarm) {
    if (sw.kind !== 1) continue; // asteroids aren't valid targets
    interpolateSwarmPose(sw, nowMs, scratch);
    out.push({
      id: `swarm-${entityId}`,
      x: scratch.x,
      y: scratch.y,
      vx: sw.vx,
      vy: sw.vy,
    });
  }
  return out;
}
