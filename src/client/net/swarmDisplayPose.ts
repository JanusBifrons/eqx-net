/**
 * The single per-frame drone display-pose accessor.
 *
 * THE RULE THIS ENFORCES (drone/laser-jitter fix, 2026-05-19; the
 * drone-snapshot-interpolation pivot's stated invariant, actually made
 * true):
 *
 *   A drone's display pose is resolved by EXACTLY ONE
 *   `interpolateSwarmPose` call per frame — in
 *   `ColyseusClient.updateMirror`, at that frame's single `now` — and
 *   written into `entry.x/y/angle`. Every consumer (renderer sprite,
 *   predWorld collision body, turret/laser aim, health bars, labels)
 *   reads THAT one value. **No consumer may re-interpolate.**
 *
 * Before this, the sprite (`PixiRenderer`) and the turret aim
 * (`buildLocalAimTargets`) each called `interpolateSwarmPose` again, at
 * their own `performance.now()` — render-now and tickPhysics-now,
 * respectively — which differ from `updateMirror`'s now by a variable,
 * raf-jitter-amplified amount (and a whole frame under the 30 Hz worker
 * sprite gate). So within one rendered frame the same drone occupied
 * three slightly different positions: the sprite, the collision body,
 * and the beam disagreed → drones "jittered like two things fighting for
 * their position" and the laser "jittered between the target and where
 * it's drawn" (on-device 2026-05-19; capture `…-jfagww`).
 *
 * `interpolateSwarmPose` itself (the display-delay buffer, teleport
 * guard, adaptive delay) is deliberately NOT touched — this is purely
 * about *who* resolves the pose and *how many times*. Sprites stay
 * smooth: the interpolation is still evaluated every frame at that
 * frame's `now`, just ONCE (in `updateMirror`) and shared.
 *
 * This is a one-liner by design. It exists as a NAMED, IMPORTED seam so
 * the "read the resolved pose, never re-interpolate" contract is
 * explicit, greppable, and unit-lockable (the
 * `tests/unit/swarmPoseConsistency.test.ts` canary) — the
 * `shouldDetachWarpVisual` / `LocalBeam` / `fireTemporal`
 * extract-the-decision precedent. Asteroids (kind=0) are NOT covered:
 * they keep render-now interpolation off the poseRing (they are
 * locked/static server-side and were never the jitter complaint).
 */
import type { SwarmRenderState } from '../../core/contracts/IRenderer.js';
import type { InterpolatedPose } from './swarmInterpolation.js';

/**
 * The drone's resolved display pose for THIS frame: the value
 * `ColyseusClient.updateMirror` already wrote into `entry.x/y/angle`
 * via the frame's single `interpolateSwarmPose` call. Mutates `out`
 * (pass a per-consumer scratch) to keep the hot path allocation-free,
 * mirroring `interpolateSwarmPose`'s contract so call sites swap 1:1.
 */
export function resolveDroneDisplayPose(
  entry: Pick<SwarmRenderState, 'x' | 'y' | 'angle'>,
  out: InterpolatedPose,
): InterpolatedPose {
  out.x = entry.x;
  out.y = entry.y;
  out.angle = entry.angle;
  return out;
}
