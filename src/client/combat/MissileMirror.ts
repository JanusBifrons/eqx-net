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
 * Resolve a missile's display pose at `nowMs`. Linear interpolation
 * between `prev*` and the latest pose, displaced by
 * `MISSILE_DISPLAY_DELAY_MS` so the renderer is sampling between two
 * arrived snapshots.
 *
 * Returns null when the missile doesn't exist (caller should skip
 * drawing). When only one snapshot has arrived (`prevArrivalMs ===
 * latestArrivalMs`), returns the latest pose with t=1.
 */
export function resolveMissileDisplayPose(
  mirror: RenderMirror,
  missileId: number,
  nowMs: number,
): { x: number; y: number; angle: number; lifePct: number } | null {
  const m = mirror.missiles?.get(missileId);
  if (!m) return null;
  const targetMs = nowMs - MISSILE_DISPLAY_DELAY_MS;
  const span = m.latestArrivalMs - m.prevArrivalMs;
  if (span <= 0) {
    return { x: m.x, y: m.y, angle: m.angle, lifePct: m.lifePct };
  }
  const t = (targetMs - m.prevArrivalMs) / span;
  // Clamp into [0, 1] — extrapolation past latest is intentionally
  // suppressed (we wait for the next snapshot rather than drift past
  // the authoritative pose).
  const tc = t < 0 ? 0 : (t > 1 ? 1 : t);
  return {
    x: m.prevX + (m.x - m.prevX) * tc,
    y: m.prevY + (m.y - m.prevY) * tc,
    // Angles can wrap; interpolate via shortest-arc.
    angle: lerpAngle(m.prevAngle, m.angle, tc),
    lifePct: m.lifePct,
  };
}

function lerpAngle(a: number, b: number, t: number): number {
  let delta = b - a;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return a + delta * t;
}
