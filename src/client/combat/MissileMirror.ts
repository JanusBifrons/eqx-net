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
 * **Interpolation strategy — pose ring (playtest 2026-06-10 Issue 11).**
 * Missiles previously dead-reckoned a STALE velocity forward from the
 * latest snapshot. At 20 Hz that diverged from the (now tighter, Issue 10)
 * homing curve between snapshots and snapped on each arrival — the
 * "missiles lag, like they only update 20 Hz" report. We now buffer recent
 * authoritative poses in a per-missile ring and INTERPOLATE between the two
 * that bracket `now − MISSILE_DISPLAY_DELAY_MS`, exactly like drones
 * (`swarmInterpolation.ts`). The visible motion is a continuous lerp of
 * buffered truth, immune to wire-arrival jitter ≤ the display delay. Past
 * the newest sample (arrivals stalled) we dead-reckon forward, capped, then
 * freeze; a teleport guard snaps across server discontinuities instead of
 * animating across them.
 */

import {
  MISSILE_POSE_RING_DEPTH,
  type RenderMirror,
  type MissileRenderState,
  type PoseRingEntry,
} from '../../core/contracts/IRenderer.js';
import type { SnapshotMessage } from '../../shared-types/messages/snapshotMessages.js';

/**
 * Display-delay lag in milliseconds. The renderer reads missile poses
 * `MISSILE_DISPLAY_DELAY_MS` behind the latest arrival so it interpolates
 * between two arrived snapshots rather than extrapolating past the latest.
 * 100 ms = 2× the 50 ms (20 Hz) snapshot cadence — covers jitter without
 * making missiles feel sluggish (the drone display-delay floor value).
 */
export const MISSILE_DISPLAY_DELAY_MS = 100;

/**
 * Maximum dead-reckoning window past the newest ring sample before freezing.
 * When the next snapshot is late (WiFi jitter, AOI roll) the renderer
 * extrapolates the missile forward with the newest sample's velocity so the
 * sprite keeps moving smoothly. Capped so a missile that left the AOI doesn't
 * fly off-screen forever (it freezes, then the 1000 ms stale-eviction reaps
 * the sprite). 250 ms covers the observed 100–200 ms jitter band + most of the
 * 500 ms tail (capture `2026-05-27T16-33-40Z-r0r701`).
 */
export const MISSILE_EXTRAPOLATION_CAP_MS = 250;

/** Teleport guard (mirrors swarmInterpolation): when two bracketing poses are
 *  further apart than any missile could plausibly travel in the span, that's a
 *  server discontinuity (despawn+id-reuse, lock re-acquire SET) — snap to the
 *  newer pose, never animate across the gap. */
const TELEPORT_MAX_PLAUSIBLE_SPEED = 2500; // u/s — above any missile speed
const TELEPORT_FLOOR_U = 64;

/** Campaign 5.1c — SLICE-DRIVEN removal. Absence from the pose slice is the
 *  authoritative despawn signal: the `missile_detonated` event is AOI-filtered
 *  independently of the slice, so a viewer could hold a live entry whose
 *  removal event was filtered away — the sprite dead-reckoned to the
 *  extrapolation cap then FROZE for the remainder of the old 1 s stale window
 *  (the "missile stops moving, then fades" report). 250 ms = the extrapolation
 *  cap (~5 snapshot cadences; tolerant of a couple of dropped/coalesced
 *  snapshots — any connected client forces the sector non-idle, so the slice
 *  stream never legitimately pauses): the entry is reaped right as its
 *  dead-reckoning caps, so a frozen phase cannot exist. The event stays as the
 *  same-frame fast path for the explosion VFX. */
const MISSILE_ABSENT_DESPAWN_MS = 250;

/** Allocate a fresh, empty pose ring for a newly-sighted missile. */
function newRing(): PoseRingEntry[] {
  const ring = new Array<PoseRingEntry>(MISSILE_POSE_RING_DEPTH);
  for (let i = 0; i < MISSILE_POSE_RING_DEPTH; i++) {
    ring[i] = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0, serverTick: 0, sleeping: false, empty: true };
  }
  return ring;
}

/** Write a fresh authoritative pose into the ring at `head`, in place. */
function writeRing(m: MissileRenderState, x: number, y: number, vx: number, vy: number, angle: number, angvel: number, arrivalMs: number, serverTick: number): void {
  const slot = m.poseRing[m.ringHead]!;
  slot.x = x; slot.y = y; slot.angle = angle;
  slot.vx = vx; slot.vy = vy; slot.angvel = angvel;
  slot.arrivalMs = arrivalMs; slot.serverTick = serverTick;
  slot.empty = false;
  m.ringHead = (m.ringHead + 1) % MISSILE_POSE_RING_DEPTH;
}

/**
 * Apply a snapshot's `missiles[]` slice to `mirror.missiles`. Pushes each
 * pose into the missile's ring (sliding the buffer), inserts new missiles,
 * and stale-evicts entries the snapshot stopped refreshing.
 *
 * `nowMs` is injected so tests can use a deterministic clock; default is
 * `performance.now()`.
 */
export function applyMissileSnapshot(
  slice: NonNullable<SnapshotMessage['missiles']> | undefined,
  mirror: RenderMirror,
  serverTick: number,
  nowMs: number = performance.now(),
): void {
  if (!mirror.missiles) mirror.missiles = new Map();
  const map = mirror.missiles;

  if (slice && slice.length > 0) {
    for (const entry of slice) {
      // Signed angular velocity (WS-C #5) — back-fills to 0 for pre-WS-C
      // servers (linear path, byte-identical to before).
      const angvel = entry.angvel ?? 0;
      const existing = map.get(entry.id);
      if (existing) {
        existing.x = entry.x;
        existing.y = entry.y;
        existing.vx = entry.vx;
        existing.vy = entry.vy;
        existing.angle = entry.angle;
        existing.lifePct = entry.lifePct;
        existing.lastUpdateTick = serverTick;
        existing.latestArrivalMs = nowMs;
        writeRing(existing, entry.x, entry.y, entry.vx, entry.vy, entry.angle, angvel, nowMs, serverTick);
      } else {
        const fresh: MissileRenderState = {
          id: entry.id,
          x: entry.x, y: entry.y,
          vx: entry.vx, vy: entry.vy,
          angle: entry.angle,
          poseRing: newRing(),
          ringHead: 0,
          latestArrivalMs: nowMs,
          lastUpdateTick: serverTick,
          ownerId: entry.ownerId,
          weaponId: entry.weaponId,
          lifePct: entry.lifePct,
        };
        writeRing(fresh, entry.x, entry.y, entry.vx, entry.vy, entry.angle, angvel, nowMs, serverTick);
        map.set(entry.id, fresh);
      }
    }
  }

  // Slice-driven despawn (campaign 5.1c): a missile the slice stopped
  // carrying — detonated with its event AOI-filtered away, or out of the
  // recipient's view — is reaped within the extrapolation cap.
  for (const [id, m] of map) {
    if (nowMs - m.latestArrivalMs > MISSILE_ABSENT_DESPAWN_MS) {
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

/** Module scratch for the populated-ring gather (alloc-free per call; sized to
 *  the ring depth — single-threaded, once-per-missile-per-frame call shape). */
const _populated: (PoseRingEntry | null)[] = new Array<PoseRingEntry | null>(MISSILE_POSE_RING_DEPTH).fill(null);

function shortestArc(target: number, source: number): number {
  let d = target - source;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Reused scratch for the curve dead-reckon result (alloc-free per call — the
 *  one-pose-per-frame call shape, mutated in place then read by the caller). */
const _curveOut = { x: 0, y: 0, angle: 0 };

/**
 * Dead-reckon a missile pose forward by `dtSec` from an authoritative ring
 * sample, following the HOMING CURVE (WS-C #5). Missiles steer, so a straight
 * `pos += v·dt` flies off the server's arc and snaps on the next snapshot.
 * Here we integrate `angle += angvel·dt` and recompute position from the curved
 * heading:
 *
 *   - `angvel ≈ 0`  → linear: `pos += v·dt` (the legacy straight path).
 *   - `angvel ≠ 0`  → exact constant-turn circular arc closed form
 *     `pos += (s/ω)·(dir(angle+ω·dt) − dir(angle))`, where `s` is the speed
 *     |v| and `dir(θ) = (−sinθ, cosθ)` (Pixi-up, matching MissileSimulation).
 *
 * Writes the result into the shared `_curveOut` scratch and returns it. Used for
 * BOTH extrapolation past the newest sample AND interpolation forward from the
 * older bracket sample (the constant-turn arc reconstructs the inter-snapshot
 * path the server integrated, within sub-unit Euler error).
 */
const ANGVEL_EPS = 1e-4; // below this, treat as straight (avoid s/ω blow-up)
function curveDeadReckon(
  x: number, y: number, vx: number, vy: number, angle: number, angvel: number, dtSec: number,
): { x: number; y: number; angle: number } {
  const newAngle = angle + angvel * dtSec;
  if (Math.abs(angvel) < ANGVEL_EPS) {
    _curveOut.x = x + vx * dtSec;
    _curveOut.y = y + vy * dtSec;
    _curveOut.angle = newAngle;
    return _curveOut;
  }
  const speed = Math.hypot(vx, vy);
  const r = speed / angvel; // signed turn radius factor
  // dir(θ) = (−sinθ, cosθ). ∫ over [angle, newAngle] gives the arc displacement.
  _curveOut.x = x + r * (Math.cos(newAngle) - Math.cos(angle));
  _curveOut.y = y + r * (Math.sin(newAngle) - Math.sin(angle));
  _curveOut.angle = newAngle;
  return _curveOut;
}

/**
 * Resolve a missile's display pose at `nowMs` by interpolating buffered
 * authoritative poses at `nowMs − MISSILE_DISPLAY_DELAY_MS`. Returns null when
 * the missile doesn't exist (caller skips drawing).
 */
export function resolveMissileDisplayPose(
  mirror: RenderMirror,
  missileId: number,
  nowMs: number,
): { x: number; y: number; angle: number; lifePct: number } | null {
  const m = mirror.missiles?.get(missileId);
  if (!m) return null;

  // Gather populated ring entries in arrivalMs-ascending order (insertion sort
  // during fill — zero alloc, beats Array.sort for n ≤ depth).
  let count = 0;
  for (let i = 0; i < MISSILE_POSE_RING_DEPTH; i++) {
    const e = m.poseRing[i];
    if (!e || e.empty) continue;
    let j = count;
    while (j > 0 && _populated[j - 1]!.arrivalMs > e.arrivalMs) {
      _populated[j] = _populated[j - 1]!;
      j--;
    }
    _populated[j] = e;
    count++;
  }

  if (count === 0) {
    return { x: m.x, y: m.y, angle: m.angle, lifePct: m.lifePct };
  }

  const targetMs = nowMs - MISSILE_DISPLAY_DELAY_MS;
  const newest = _populated[count - 1]!;
  const oldest = _populated[0]!;

  // Single sample, or render time before our oldest sample (campaign 5.1b).
  // The old pin froze every missile at its first pose for ~display-delay
  // (and on every AOI re-entry), then JUMPED when interpolation began —
  // drones never showed this because their cadence is 3× higher. Reconstruct
  // along the sample's own velocity/homing curve instead: dt is clamped to
  // [−display-delay, +extrapolation-cap], so the pose flies smoothly from
  // the very first rendered frame (backward reconstruction retraces the
  // path the missile actually flew before the sample; a zero-velocity
  // sample still resolves to the sample point — the legacy behaviour).
  if (count === 1 || targetMs <= oldest.arrivalMs) {
    const rawDtMs = targetMs - oldest.arrivalMs;
    const dtMs = Math.max(-MISSILE_DISPLAY_DELAY_MS, Math.min(MISSILE_EXTRAPOLATION_CAP_MS, rawDtMs));
    const c = curveDeadReckon(oldest.x, oldest.y, oldest.vx, oldest.vy, oldest.angle, oldest.angvel, dtMs / 1000);
    return { x: c.x, y: c.y, angle: c.angle, lifePct: m.lifePct };
  }

  // Render time past the newest arrival: dead-reckon forward along the HOMING
  // CURVE with the newest sample's velocity + angvel (WS-C #5), capped, then
  // freeze. Pre-WS-C this held `angle` and coasted straight — which flew off the
  // server's turning path and snapped on the next arrival.
  if (targetMs >= newest.arrivalMs) {
    const overshootMs = Math.min(MISSILE_EXTRAPOLATION_CAP_MS, targetMs - newest.arrivalMs);
    const dt = overshootMs / 1000;
    const c = curveDeadReckon(newest.x, newest.y, newest.vx, newest.vy, newest.angle, newest.angvel, dt);
    return { x: c.x, y: c.y, angle: c.angle, lifePct: m.lifePct };
  }

  // Interpolation window — find adjacent populated entries a,b bracketing target.
  let a: PoseRingEntry = oldest;
  let b: PoseRingEntry = _populated[1]!;
  for (let i = 0; i < count - 1; i++) {
    const lo = _populated[i]!;
    const hi = _populated[i + 1]!;
    if (targetMs >= lo.arrivalMs && targetMs < hi.arrivalMs) { a = lo; b = hi; break; }
  }

  const span = b.arrivalMs - a.arrivalMs;
  // Teleport guard: snap across server discontinuities, never animate them.
  const gap = Math.hypot(b.x - a.x, b.y - a.y);
  const maxPlausible = Math.max(TELEPORT_FLOOR_U, (TELEPORT_MAX_PLAUSIBLE_SPEED * Math.max(0, span)) / 1000);
  if (gap > maxPlausible) {
    return { x: b.x, y: b.y, angle: b.angle, lifePct: m.lifePct };
  }

  // Curve-aware interpolation (WS-C #5): dead-reckon forward from the OLDER
  // bracket sample `a` along its homing arc by `targetMs − a.arrivalMs`. For a
  // steering missile the constant-turn arc reconstructs the path the server
  // integrated between the two snapshots — so the rendered missile follows the
  // CURVE instead of cutting the straight chord (the per-arrival snap). When
  // `a.angvel ≈ 0` this reduces to the exact linear lerp the old code used
  // (back-compat with pre-WS-C servers / dumb-flying missiles). The angle is
  // taken from the arc integration, which lands at ~`b.angle` by `span`
  // (continuity into the next bracket).
  const dt = span > 0 ? Math.max(0, targetMs - a.arrivalMs) / 1000 : 0;
  if (Math.abs(a.angvel) < ANGVEL_EPS) {
    // Linear fast path — straight lerp between the two buffered samples (the
    // original behaviour; keeps the smooth two-sample blend for non-steering
    // missiles and matches the legacy locked tests exactly).
    const t = span > 0 ? Math.max(0, Math.min(1, (targetMs - a.arrivalMs) / span)) : 0;
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      angle: a.angle + shortestArc(b.angle, a.angle) * t,
      lifePct: m.lifePct,
    };
  }
  const c = curveDeadReckon(a.x, a.y, a.vx, a.vy, a.angle, a.angvel, dt);
  return { x: c.x, y: c.y, angle: c.angle, lifePct: m.lifePct };
}
