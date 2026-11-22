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
 * that bracket `now − display delay` (the shared drone delay, S5-4), exactly like drones
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
// Shared teleport bound (one definition for every client interpolator).
import { isImplausibleJump } from '../net/plausibleSpeed.js';
// Read-only tick → stamp conversion on the drone display timeline (S5-2).
import {
  ADAPTIVE_DELAY_CEILING_MS,
  MAX_TOTAL_DISPLAY_DELAY_MS,
  getSwarmDisplayDelayMs,
  getSwarmDisplayDelayTargetMs,
  getSwarmDisplaySpeed,
  getSwarmHoldMaxWallMs,
  getSwarmRingMinSpacingMs,
  getSwarmStreamNewestStampMs,
  isSwarmDelayCatchingUp,
  isSwarmDelayOffPilotActive,
  swarmTickToStampMs,
} from '../net/swarmInterpolation.js';
// The display-delay slew + stall hold, shared with drones (S5-5, D10 = A).
import {
  createDisplayDelayHoldState,
  holdDisplayDelay,
  resetDisplayDelayHold,
  slewDisplayDelay,
} from '../net/displayDelayHold.js';
// The stamped-hold deadline shared with held hits (off-pilot event timing).
import { STAMPED_HOLD_MARGIN_MS, matchedHoldMs } from '../net/navalHitHold.js';

/**
 * FALLBACK display delay (GAME ms; wall = 100 / time scale), used only before
 * the drone tick clock seeds (no drone packet yet). Once it seeds, missiles
 * read at their own stream's delay (`mirror.swarmDisplayDelayMs`, S5-4/S5-5),
 * which heads for the drone delay's target so a missile and the drone it
 * chases are drawn at the same lateness.
 * 100 ms = 2× the 50 ms (20 Hz) snapshot cadence (the drone delay floor).
 */
export const MISSILE_DISPLAY_DELAY_MS = 100;

// Missile stream hold (netcode gap smoothing S5-5, owner decision D10 = A).
// Missiles ride the JSON snapshot stream and drones the binary stream; the two
// can stall separately. So the missile stream has its OWN display-delay record
// run through the SAME slew + hold as drones (`displayDelayHold.ts`): its
// target is the drone delay's target (equal lateness on a healthy link), but
// it holds on the JSON stream's newest stamp. A JSON-only stall parks the
// missile read point at "newest + extrapolation cap" and missiles resume from
// there (no snap); a swarm-only stall holds drones while missiles play on.
// Main-thread state: the renderer may run in a worker, so the value rides the
// mirror. Scalars only.
const _missileHold = createDisplayDelayHoldState(MISSILE_DISPLAY_DELAY_MS);
/** False until the first step with a drone timeline; the record then starts
 *  AT the drone delay. Re-seeded on a speed change (the drone delay is
 *  re-clamped at once then). */
let _missileHoldSeeded = false;
let _missileHoldSpeed = 1;
/** Newest server tick seen on the JSON snapshot stream and its stamp (wall
 *  ms, drone tick timeline; arrival time before that clock seeds). */
let _missileStreamNewestTick = -1;
let _missileStreamNewestStampMs = Number.NaN;

/** Note one JSON snapshot of `tick` stamped `stampMs` (newer tick wins). */
function noteMissileStreamStamp(tick: number, stampMs: number): void {
  if (tick <= _missileStreamNewestTick) return;
  _missileStreamNewestTick = tick;
  _missileStreamNewestStampMs = stampMs;
}

/**
 * Step the missile stream's display delay one frame and publish it on the
 * mirror (netcode gap smoothing S5-4, S5-5). Call once per frame right after
 * `stepSwarmDisplayDelay`, with the same frame dt and read clock, before the
 * renderer resolves missiles. WALL ms (floor and ceiling already ÷ speed).
 * NaN until the first tick-stamped drone packet after a reset (no drone
 * timeline yet), which makes `resolveMissileDisplayPose` fall back to
 * `MISSILE_DISPLAY_DELAY_MS`.
 */
export function stepMissileDisplayDelay(mirror: RenderMirror, frameDtMs: number, nowMs: number): void {
  if (Number.isNaN(getSwarmStreamNewestStampMs())) {
    _missileHoldSeeded = false;
    mirror.swarmDisplayDelayMs = Number.NaN;
    releaseMissileDetonations(mirror, nowMs, Number.NaN);
    return;
  }
  const speed = getSwarmDisplaySpeed();
  _missileHold.targetMs = getSwarmDisplayDelayTargetMs();
  if (!_missileHoldSeeded || speed !== _missileHoldSpeed) {
    _missileHold.delayMs = getSwarmDisplayDelayMs();
    _missileHoldSeeded = true;
    _missileHoldSpeed = speed;
  } else {
    // The drone record's mode (S5-9): its catch-up slew and hold maximum.
    slewDisplayDelay(_missileHold, frameDtMs, speed, isSwarmDelayCatchingUp());
  }
  holdDisplayDelay(
    _missileHold, nowMs, _missileStreamNewestStampMs, MISSILE_EXTRAPOLATION_CAP_MS / speed, speed, getSwarmHoldMaxWallMs(),
  );
  mirror.swarmDisplayDelayMs = _missileHold.delayMs;
  releaseMissileDetonations(mirror, nowMs, nowMs - _missileHold.delayMs);
}

/** Forget the missile stream's delay, newest stamp and counters (sector
 *  change: `resetPredictionState`; tests). */
export function resetMissileDisplayDelay(): void {
  resetDisplayDelayHold(_missileHold, MISSILE_DISPLAY_DELAY_MS);
  _missileHold.holdFrameCount = 0;
  _missileHold.resyncCount = 0;
  _missileHoldSeeded = false;
  _missileHoldSpeed = 1;
  _missileStreamNewestTick = -1;
  _missileStreamNewestStampMs = Number.NaN;
}

/** Frames on which a JSON stream stall held the missile read point. */
export function getMissileHoldFrameCount(): number { return _missileHold.holdFrameCount; }
/** Missile stream re-syncs (a hold past MAX_TOTAL_DISPLAY_DELAY_MS). */
export function getMissileResyncCount(): number { return _missileHold.resyncCount; }

/** The delay (wall ms) missiles read at this frame: the published missile
 *  stream delay, or the fixed fallback ÷ speed while it is NaN / absent. */
function missileDisplayDelayWallMs(mirror: RenderMirror, speed: number): number {
  const shared = mirror.swarmDisplayDelayMs;
  if (shared !== undefined && shared > 0 && Number.isFinite(shared)) return shared;
  return MISSILE_DISPLAY_DELAY_MS / speed;
}

/** The mirror's game speed (1 when absent or invalid). */
function mirrorSpeed(mirror: RenderMirror): number {
  const s = mirror.timeScale;
  return s !== undefined && s > 0 && Number.isFinite(s) ? s : 1;
}

/**
 * Maximum dead-reckoning window past the newest ring sample before freezing,
 * in GAME ms (wall = 250 / time scale, like the drone glide limit).
 * When the next snapshot is late (WiFi jitter, AOI roll) the renderer
 * extrapolates the missile forward with the newest sample's velocity so the
 * sprite keeps moving smoothly. Capped so a missile that left the AOI doesn't
 * fly off-screen forever (it freezes, then the 1000 ms stale-eviction reaps
 * the sprite). 250 ms covers the observed 100–200 ms jitter band + most of the
 * 500 ms tail (capture `2026-05-27T16-33-40Z-r0r701`).
 */
export const MISSILE_EXTRAPOLATION_CAP_MS = 250;

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

/** The absent-from-slice despawn window (wall ms) this frame. Off pilot
 *  (S5-9) the read point sits up to seconds back, so a missile that left the
 *  slice is kept for the delay past the pilot ceiling as well: it flies its
 *  last buffered poses out instead of vanishing mid-flight. Pilot: 250. */
function missileAbsentDespawnMs(): number {
  if (!isSwarmDelayOffPilotActive()) return MISSILE_ABSENT_DESPAWN_MS;
  const extraMs = _missileHold.delayMs - ADAPTIVE_DELAY_CEILING_MS / getSwarmDisplaySpeed();
  return MISSILE_ABSENT_DESPAWN_MS + Math.max(0, extraMs);
}

/** True when a pose stamped `stampMs` should skip the ring (S5-9 off-pilot
 *  thinning): the newest slot is under `spacingMs` older. 0 = never skip. */
function isRingWriteThinned(m: MissileRenderState, stampMs: number, spacingMs: number): boolean {
  if (!(spacingMs > 0)) return false;
  const newest = m.poseRing[(m.ringHead + MISSILE_POSE_RING_DEPTH - 1) % MISSILE_POSE_RING_DEPTH]!;
  const sinceMs = stampMs - newest.arrivalMs;
  return !newest.empty && sinceMs >= 0 && sinceMs < spacingMs;
}

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

  // Playback stamp (S5-2): every missile in the slice is a pose at
  // `serverTick`, placed on the drone tick timeline so a backlog drained in
  // one frame keeps its server spacing. Before that clock is seeded (no
  // drone packet yet) the sample keeps its arrival stamp. Any snapshot, with
  // missiles or not, shows the JSON stream is alive (the S5-5 hold).
  const tickStampMs = swarmTickToStampMs(serverTick, nowMs);
  const stampMs = Number.isNaN(tickStampMs) ? nowMs : tickStampMs;
  noteMissileStreamStamp(serverTick, stampMs);

  if (slice && slice.length > 0) {
    const spacingMs = getSwarmRingMinSpacingMs(MISSILE_POSE_RING_DEPTH);
    for (const entry of slice) {
      // Signed angular velocity (WS-C #5) — back-fills to 0 for pre-WS-C
      // servers (linear path, byte-identical to before).
      const angvel = entry.angvel ?? 0;
      const existing = map.get(entry.id);
      const stampWentBack = existing !== undefined && !Number.isNaN(tickStampMs) && isStampBehindRing(existing, stampMs, serverTick);
      if (existing) {
        existing.x = entry.x;
        existing.y = entry.y;
        existing.vx = entry.vx;
        existing.vy = entry.vy;
        existing.angle = entry.angle;
        existing.lifePct = entry.lifePct;
        existing.lastUpdateTick = serverTick;
        existing.latestArrivalMs = nowMs;
        if (stampWentBack || !isRingWriteThinned(existing, stampMs, spacingMs)) {
          writeRing(existing, entry.x, entry.y, entry.vx, entry.vy, entry.angle, angvel, stampMs, serverTick);
        }
        if (stampWentBack) restampRing(existing, nowMs);
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
        writeRing(fresh, entry.x, entry.y, entry.vx, entry.vy, entry.angle, angvel, stampMs, serverTick);
        map.set(entry.id, fresh);
      }
    }
  }

  // Slice-driven despawn (campaign 5.1c): a missile the slice stopped
  // carrying — detonated with its event AOI-filtered away, or out of the
  // recipient's view — is reaped within the extrapolation cap.
  const despawnMs = missileAbsentDespawnMs();
  for (const [id, m] of map) {
    // A held detonation leaves on its own release (`releaseMissileDetonations`).
    if (m.detStampMs === undefined && nowMs - m.latestArrivalMs > despawnMs) {
      map.delete(id);
    }
  }
}

/** True when a NEWER tick would be stamped at or before a sample already in
 *  the ring: the basis moved (arrival stamps → tick stamps once the drone
 *  clock seeds, or a tick-clock re-seed), so ring order would run backwards. */
function isStampBehindRing(m: MissileRenderState, stampMs: number, serverTick: number): boolean {
  for (let i = 0; i < MISSILE_POSE_RING_DEPTH; i++) {
    const e = m.poseRing[i]!;
    if (!e.empty && e.serverTick < serverTick && e.arrivalMs >= stampMs) return true;
  }
  return false;
}

/** Re-stamp every ring sample from its own tick on the current tick clock, so
 *  the whole ring shares one basis (in place, zero alloc). Only called after a
 *  tick stamp was taken, so the clock is seeded and no stamp is NaN. */
function restampRing(m: MissileRenderState, nowMs: number): void {
  for (let i = 0; i < MISSILE_POSE_RING_DEPTH; i++) {
    const e = m.poseRing[i]!;
    if (!e.empty) e.arrivalMs = swarmTickToStampMs(e.serverTick, nowMs);
  }
}

/**
 * Remove a missile from the mirror immediately (a detonation that cannot
 * wait for the drawn missile: `holdMissileDetonation`), so the sprite stops
 * being drawn the frame the explosion VFX appears.
 */
export function removeMissile(mirror: RenderMirror, missileId: number): void {
  mirror.missiles?.delete(missileId);
}

/**
 * `missile_detonated` arrived (off-pilot event timing, slice 3/6). The event
 * carries no tick and the missile is drawn on the missile stream's display
 * delay (100-150 ms piloting, up to seconds off pilot), so removing it at once
 * made the drawn missile vanish mid-flight with the blast ahead of it. If the
 * missile is in the mirror and the drone tick clock is seeded, it is KEPT
 * (still drawn, exempt from the absent-from-slice despawn) with a stamp: the
 * newest JSON snapshot tick at arrival, on the drone tick clock. The per-frame
 * step removes it and queues the explosion at (x, y) once the missile read
 * point (now − the missile delay, what `resolveMissileDisplayPose` reads)
 * reaches the stamp, or at the deadline: the current delay + the stamped-hold
 * margin, capped by `matchedHoldMs` (as `NavalHitHold.holdStamped`).
 * Otherwise it is removed and explodes at once (the old path).
 */
export function holdMissileDetonation(
  mirror: RenderMirror, missileId: number, x: number, y: number, splashRadius: number, nowMs: number,
): void {
  const m = mirror.missiles?.get(missileId);
  const stampMs = _missileStreamNewestTick < 0 ? Number.NaN : swarmTickToStampMs(_missileStreamNewestTick, nowMs);
  if (m === undefined || Number.isNaN(stampMs)) {
    removeMissile(mirror, missileId);
    pushMissileExplosion(mirror, missileId, x, y, splashRadius);
    return;
  }
  const speed = getSwarmDisplaySpeed();
  const holdGameMs = Math.min(
    _missileHold.delayMs * speed + STAMPED_HOLD_MARGIN_MS, matchedHoldMs(isSwarmDelayOffPilotActive()),
  );
  m.detStampMs = stampMs;
  m.detDeadlineMs = nowMs + holdGameMs / speed;
  m.detX = x; m.detY = y; m.detSplash = splashRadius;
}

/** Release every held detonation whose stamp the missile read point
 *  `readPointMs` (NaN: none this frame) reached, or whose deadline passed:
 *  remove the missile and queue its explosion. Run by the per-frame step. */
function releaseMissileDetonations(mirror: RenderMirror, nowMs: number, readPointMs: number): void {
  const map = mirror.missiles;
  if (map === undefined) return;
  for (const [id, m] of map) {
    const stampMs = m.detStampMs;
    if (stampMs === undefined || !(readPointMs >= stampMs || nowMs >= m.detDeadlineMs!)) continue;
    map.delete(id);
    pushMissileExplosion(mirror, id, m.detX!, m.detY!, m.detSplash!);
  }
}

/** Drop every held detonation and its missile, with no explosion (welcome or
 *  sector change: those missiles belong to the old room). */
export function clearMissileDetonations(mirror: RenderMirror): void {
  const map = mirror.missiles;
  if (map === undefined) return;
  for (const [id, m] of map) if (m.detStampMs !== undefined) map.delete(id);
}

function pushMissileExplosion(mirror: RenderMirror, missileId: number, x: number, y: number, splashRadius: number): void {
  (mirror.pendingMissileExplosions ??= []).push({ x, y, splashRadius, missileId });
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
 * authoritative poses at `nowMs − display delay` (the shared drone delay, S5-4). Returns null when
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

  // The missile stream delay (S5-4, S5-5), already WALL ms; before the drone
  // clock seeds, the fixed GAME-ms fallback ÷ speed (snapshots arrive 1/speed
  // as far apart in wall time). Ring stamps are wall ms and velocities per
  // GAME second, so every dead-reckon dt is wall ms × speed, and the cap
  // (game ms) is ÷ speed in wall ms (as drones, S4-1b).
  const speed = mirrorSpeed(mirror);
  const capWallMs = MISSILE_EXTRAPOLATION_CAP_MS / speed;
  const delayMs = missileDisplayDelayWallMs(mirror, speed);
  const targetMs = nowMs - delayMs;
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
    // Off pilot (S5-9) the read point can sit seconds before a new missile's
    // first sample: it has not launched yet on screen. Never in pilot (the
    // delay is at most MAX_TOTAL_DISPLAY_DELAY_MS / speed there).
    if (rawDtMs < -MAX_TOTAL_DISPLAY_DELAY_MS / speed) return null;
    const dtMs = Math.max(-delayMs, Math.min(capWallMs, rawDtMs));
    const c = curveDeadReckon(oldest.x, oldest.y, oldest.vx, oldest.vy, oldest.angle, oldest.angvel, dtMs * speed / 1000);
    return { x: c.x, y: c.y, angle: c.angle, lifePct: m.lifePct };
  }

  // Render time past the newest arrival: dead-reckon forward along the HOMING
  // CURVE with the newest sample's velocity + angvel (WS-C #5), capped, then
  // freeze. Pre-WS-C this held `angle` and coasted straight — which flew off the
  // server's turning path and snapped on the next arrival.
  if (targetMs >= newest.arrivalMs) {
    const overshootMs = Math.min(capWallMs, targetMs - newest.arrivalMs);
    const dt = overshootMs * speed / 1000;
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
  // Teleport guard: when two bracketing poses are further apart than any
  // missile could plausibly travel in the span, that's a server discontinuity
  // (despawn+id-reuse, lock re-acquire SET) — snap to the newer pose, never
  // animate across the gap.
  // The bound is a game-time speed: the span between stamps is WALL ms, so
  // scale it to game ms (at 2× a wall ms carries two game ms of travel).
  const gap = Math.hypot(b.x - a.x, b.y - a.y);
  if (isImplausibleJump(gap, span * speed)) {
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
  const dt = span > 0 ? Math.max(0, targetMs - a.arrivalMs) * speed / 1000 : 0;
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
