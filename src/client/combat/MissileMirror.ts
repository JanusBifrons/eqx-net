/**
 * Client-side missile mirror — applies `SnapshotMessage.missiles[]`
 * entries into `mirror.missiles` and exposes the single per-frame
 * pose-resolution seam.
 *
 * **One-pose-per-frame contract** (mirrors the drone rule in
 * src/client/CLAUDE.md): `resolveMissileDisplayPose` is the only place
 * the renderer / camera-shake source / future trail emitter may read a
 * missile's display position from. Consumers MUST cache the resolved
 * value for that frame — re-calling at a different `now` produces a
 * different pose and the sprite/trail/etc. would disagree per-frame
 * (the same jitter class the drone-interpolation pivot eliminated).
 *
 * Interpolation strategy: linear between the previous and latest
 * snapshot poses, with `display-delay` lag so the renderer is reading a
 * pose that's actually arrived (no clock skew). Missiles are
 * short-lived enough that a teleport-guard isn't needed — a missile
 * that warped across the map would be a server bug, not normal
 * gameplay.
 */

import type { RenderMirror, MissileRenderState } from '../../core/contracts/IRenderer.js';
import type { SnapshotMessage } from '../../shared-types/messages/snapshotMessages.js';

/**
 * Display-delay lag in milliseconds. The renderer reads missile poses
 * `DISPLAY_DELAY_MS` behind the latest arrival, so it's interpolating
 * between two arrived snapshots rather than extrapolating past the
 * latest. 50 ms is the snapshot cadence (20 Hz); doubling it covers
 * jitter without making missiles feel sluggish.
 */
export const MISSILE_DISPLAY_DELAY_MS = 100;

/**
 * Maximum velocity-extrapolation window past the latest snapshot. When
 * the next snapshot is late (WiFi jitter, snapshot AOI roll, etc.) the
 * renderer dead-reckons the missile forward using `vx`/`vy` from the
 * latest snapshot so the sprite keeps moving smoothly instead of
 * plateauing. Capped so a missile that has actually left the AOI
 * doesn't keep flying off-screen forever (it freezes after this window,
 * and the 1000 ms stale-eviction backstop removes the sprite).
 *
 * Raised 80 → 250 ms (2026-05-27, post smoke-test #N). Observed
 * snapshot intervalMs distribution from `2026-05-27T16-33-40Z-r0r701`:
 * 5 intervals in 100-200 ms range, 2 in ≥500 ms range. With an 80 ms
 * cap, every gap beyond ~180 ms (DISPLAY_DELAY+CAP) froze the missile
 * sprite — the user's "still jittery" report. 250 ms covers the entire
 * 100-200 ms band and most of the 500 ms tail until the main thread
 * un-stalls. At 400 u/s the cap is 100 u of forward drift; the homing
 * curve still arrives via the next snapshot's pose stamp and the
 * arrival correction is the same regardless of cap.
 */
export const MISSILE_EXTRAPOLATION_CAP_MS = 250;

/**
 * Apply a snapshot's `missiles[]` slice to `mirror.missiles`. Updates
 * existing entries (sliding prev → latest), inserts new ones, and
 * cleans up entries the snapshot omitted from a full-snapshot view —
 * but we don't have a "full vs delta" bit on the JSON snapshot, so we
 * rely on `missile_detonated` for explicit lifetime end and a
 * 1000 ms stale-eviction backstop for missiles that left the AOI.
 *
 * `nowMs` is injected so tests can use a deterministic clock; default
 * is `performance.now()`.
 */
export function applyMissileSnapshot(
  slice: NonNullable<SnapshotMessage['missiles']> | undefined,
  mirror: RenderMirror,
  serverTick: number,
  nowMs: number = performance.now(),
): void {
  if (!mirror.missiles) mirror.missiles = new Map();
  const map = mirror.missiles;

  if (!slice || slice.length === 0) {
    // Nothing in this snapshot — fall through to stale-eviction below.
  } else {
    for (const entry of slice) {
      const existing = map.get(entry.id);
      if (existing) {
        // Slide previous pose → latest before stamping the new pose.
        existing.prevX = existing.x;
        existing.prevY = existing.y;
        existing.prevAngle = existing.angle;
        existing.prevArrivalMs = existing.latestArrivalMs;
        existing.latestArrivalMs = nowMs;
        existing.x = entry.x;
        existing.y = entry.y;
        existing.vx = entry.vx;
        existing.vy = entry.vy;
        existing.angle = entry.angle;
        existing.lifePct = entry.lifePct;
        existing.lastUpdateTick = serverTick;
      } else {
        const fresh: MissileRenderState = {
          id: entry.id,
          x: entry.x, y: entry.y,
          vx: entry.vx, vy: entry.vy,
          angle: entry.angle,
          prevX: entry.x, prevY: entry.y, prevAngle: entry.angle,
          prevArrivalMs: nowMs,
          latestArrivalMs: nowMs,
          lastUpdateTick: serverTick,
          ownerId: entry.ownerId,
          weaponId: entry.weaponId,
          lifePct: entry.lifePct,
        };
        map.set(entry.id, fresh);
      }
    }
  }

  // Stale-eviction backstop: missiles that haven't been refreshed for
  // STALE_THRESHOLD_MS get removed. Covers the case where a missile
  // leaves the recipient's AOI window without a `missile_detonated`
  // arriving (the server has already cleaned it up; we just notice).
  const STALE_THRESHOLD_MS = 1000;
  for (const [id, m] of map) {
    if (nowMs - m.latestArrivalMs > STALE_THRESHOLD_MS) {
      map.delete(id);
    }
  }
}

/**
 * Remove a missile from the mirror immediately. Called on
 * `missile_detonated` arrival so the sprite stops being drawn the
 * frame the explosion VFX appears.
 */
export function removeMissile(mirror: RenderMirror, missileId: number): void {
  mirror.missiles?.delete(missileId);
}

/**
 * Resolve a missile's display pose at `nowMs`.
 *
 * **PURE velocity-based dead-reckoning from the latest server snapshot.**
 * Replaces the previous lerp-between-prev-and-latest (which used wall-
 * clock arrival times as the lerp span — observed snapshot intervalMs
 * jitter of 29-200 ms made the visible speed CHEAT THE SAME 50 ms of
 * server-side missile motion across varying wall-clock windows → the
 * sprite appeared to speed up / slow down per snapshot = "jittery").
 *
 * The new behaviour: position = `latest + velocity × dt` where `dt` is
 * the wall-clock distance from the latest snapshot's arrival minus the
 * `MISSILE_DISPLAY_DELAY_MS` headroom. Because `vx`/`vy` is the server-
 * authoritative speed, the visible motion is exactly the server's
 * motion — immune to WS arrival jitter. Each new snapshot snaps `latest`
 * to the fresh authoritative pose; for straight flight the snap is
 * invisible (extrap matches actual); for homing turns the snap is at
 * most `turnRate × snapshot_interval ≈ 1.5 × 0.05 ≈ 0.075 rad` of
 * heading drift, far below the human curvature-detection threshold for
 * a moving missile.
 *
 * Bounded BOTH directions:
 *   - Backward by `MISSILE_DISPLAY_DELAY_MS` (the display-delay window).
 *   - Forward by `MISSILE_EXTRAPOLATION_CAP_MS` (so a missile that has
 *     left the AOI doesn't keep flying off-screen; the 1000 ms stale-
 *     eviction backstop removes the sprite shortly after).
 *
 * Returns null when the missile doesn't exist (caller skips drawing).
 */
export function resolveMissileDisplayPose(
  mirror: RenderMirror,
  missileId: number,
  nowMs: number,
): { x: number; y: number; angle: number; lifePct: number } | null {
  const m = mirror.missiles?.get(missileId);
  if (!m) return null;
  // Wall-clock distance from "now minus display delay" to the latest
  // snapshot's arrival time. Negative ⇒ rendering BEFORE the latest
  // snapshot landed (the display-delay buffer); positive ⇒ rendering
  // AHEAD of latest (no newer snapshot yet, dead-reckon forward).
  const overshootMs = nowMs - m.latestArrivalMs - MISSILE_DISPLAY_DELAY_MS;
  const clampedMs = overshootMs < -MISSILE_DISPLAY_DELAY_MS
    ? -MISSILE_DISPLAY_DELAY_MS
    : (overshootMs > MISSILE_EXTRAPOLATION_CAP_MS
        ? MISSILE_EXTRAPOLATION_CAP_MS
        : overshootMs);
  const dt = clampedMs / 1000;
  return {
    x: m.x + m.vx * dt,
    y: m.y + m.vy * dt,
    // Angle is held from the latest snapshot. Predicting the homing
    // turn locally would diverge from server reality; the small lag
    // is invisible at typical missile speeds + turn rates.
    angle: m.angle,
    lifePct: m.lifePct,
  };
}

