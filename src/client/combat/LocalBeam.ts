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
import { resolveDroneDisplayPose } from '../net/swarmDisplayPose';

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
 * Each drone's aim position is read from the SINGLE per-frame display
 * pose that `ColyseusClient.updateMirror` already resolved (one
 * `interpolateSwarmPose` call per frame, written into `entry.x/y/angle`,
 * and the pose the predWorld collision body + sprite + laser beam all
 * use) — via `resolveDroneDisplayPose`. It does **not** re-interpolate.
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
/** A ship pose in the frame the player actually SEES it (lerp-included
 *  `mirror.ships`), not the raw `predWorld` pose. */
export interface BeamShipPose {
  x: number;
  y: number;
  angle: number;
}

/** One mount's hitscan ray, world-space. */
export interface LocalBeamRay {
  fromX: number;
  fromY: number;
  fwdX: number;
  fwdY: number;
}

/** Barrel-tip clearance along the mount's fire direction. MUST match the
 *  20 u server-side self-hit clearance in `SectorRoom.handleFire` and the
 *  renderer's `BARREL_LENGTH` so the drawn beam emerges from the visible
 *  barrel tip and the hit-test ray starts there too. */
export const LOCAL_BEAM_BARREL_OFFSET = 20;

/**
 * Resolve one mount's local hitscan ray from the ship pose the RENDERER
 * draws (lerp-included `mirror.ships`), not the raw `predWorld` pose.
 *
 * Why (parked local-ship-origin frame mismatch — the `0e24448`
 * drone-TARGET fix's mirror image, ORIGIN side): the renderer draws the
 * local beam from `mirror.ships.get(localId)` (predWorld pose + lerp
 * offset) while `updateLiveBeam` hit-tested from raw
 * `predWorld.getShipState(localId)`. When a reconcile lerp offset is
 * active (e.g. post-correction) the two diverge by the FULL correction
 * magnitude, so the drawn beam points/originates differently from where
 * it was hit-tested — it visually misses. Sourcing the ray from the
 * rendered pose makes draw-origin == hit-test-origin by construction;
 * the residual collapses to the same accepted ≤1-frame "render the
 * past" lead-lag as `buildLocalAimTargets` (both run in `tickPhysics`,
 * before `updateMirror`, so they read the prior frame's written pose).
 * Presentation only — `liveBeams` drives the DRAWN beam; the server
 * stays hit-authoritative via its own SnapshotRing-rewound ray.
 *
 * Geometry is byte-identical to the prior inline `updateLiveBeam` math;
 * only the pose SOURCE changes. `mountAngle` is the absolute world fire
 * angle (`pose.angle + mount.baseAngle + currentMountAngle`) — resolved
 * by the caller so this stays a pure value fn with no mount types.
 */
export function resolveLocalBeamRay(
  pose: BeamShipPose,
  mountLocalX: number,
  mountLocalY: number,
  mountAngle: number,
): LocalBeamRay {
  const cosA = Math.cos(pose.angle);
  const sinA = Math.sin(pose.angle);
  const mountWorldX = pose.x + (mountLocalX * cosA - mountLocalY * sinA);
  const mountWorldY = pose.y + (mountLocalX * sinA + mountLocalY * cosA);
  const fwdX = -Math.sin(mountAngle);
  const fwdY = Math.cos(mountAngle);
  return {
    fromX: mountWorldX + fwdX * LOCAL_BEAM_BARREL_OFFSET,
    fromY: mountWorldY + fwdY * LOCAL_BEAM_BARREL_OFFSET,
    fwdX,
    fwdY,
  };
}

export function buildLocalAimTargets(
  swarm: ReadonlyMap<number, SwarmRenderState>,
  scratch: InterpolatedPose,
): LocalAimTarget[] {
  const out: LocalAimTarget[] = [];
  for (const [entityId, sw] of swarm) {
    if (sw.kind !== 1) continue; // asteroids aren't valid targets
    resolveDroneDisplayPose(sw, scratch);
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
