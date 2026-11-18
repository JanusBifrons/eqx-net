import type { PoseRingEntry } from './SwarmRenderState.js';

/** Depth of the per-missile pose ring (playtest 2026-06-10 Issue 11). Sized to
 *  cover MISSILE_DISPLAY_DELAY_MS (+ jitter headroom) at the 20 Hz JSON snapshot
 *  cadence (~50 ms): 100 ms back ≈ 2 intervals, +headroom for the 100–200 ms
 *  jitter band the smoke captures showed → 6 keeps two bracketing samples
 *  available so the hot path is a genuine lerp of buffered truth (mirrors the
 *  drone POSE_RING_DEPTH sizing rule). */
export const MISSILE_POSE_RING_DEPTH = 6;

/**
 * Heat-seeking missile render state. Latest authoritative pose plus a per-missile
 * pose RING (playtest 2026-06-10 Issue 11) so the renderer interpolates between
 * BUFFERED authoritative poses at `now − displayDelay` — total immunity to
 * wire-arrival jitter — instead of dead-reckoning a stale velocity past the
 * latest snapshot (which diverged from the homing curve on a tight turn and
 * snapped each packet = the "~20 Hz look"). Same pattern as drones
 * (`swarmInterpolation.ts`), reusing `PoseRingEntry`.
 *
 * One-pose-per-frame contract: any consumer (sprite, trail emitter,
 * camera-shake source) MUST read the resolved `x/y/angle` via
 * `resolveMissileDisplayPose()`, not re-walk the ring. Mirrors the drone
 * one-pose rule in src/client/CLAUDE.md.
 */
export interface MissileRenderState {
  /** Stable per-sector u32 id from the snapshot. */
  id: number;
  /** Latest authoritative pose (the newest ring sample, mirrored for the
   *  count-1 / first-frame fast path + stale reads). */
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  /** Pose ring of recent authoritative arrivals (newest by `arrivalMs`).
   *  `resolveMissileDisplayPose` brackets `now − displayDelay` within it. */
  poseRing: PoseRingEntry[];
  /** Next ring write slot (cycles 0..MISSILE_POSE_RING_DEPTH-1). */
  ringHead: number;
  /** Arrival timestamp (renderer clock) of the latest pose — stale-eviction. */
  latestArrivalMs: number;
  /** Server tick of the latest snapshot — for stale-eviction logic. */
  lastUpdateTick: number;
  /** Owner shooter id (wire form). Renderer routes camera-shake
   *  source-vector to this id if it's the local player. */
  ownerId: string;
  weaponId: 'heat-seeker';
  /** Remaining life as a fraction [0..1]. Renderer fades the trail near
   *  end-of-life. */
  lifePct: number;
}

export interface ProjectileRenderState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ownerId: string;
  /** true for client-predicted ghosts that haven't been server-confirmed yet */
  isGhost?: boolean;
  /** 0–1 opacity for fade-out effect */
  alpha?: number;
  /** When present, render as an instant beam line from (x,y) to (toX,toY) rather than a moving dot. */
  beam?: { toX: number; toY: number };
  /** Weapon catalogue id — drives visual style (e.g. 'laser' → bolt graphic). */
  weaponId?: string;
  /** Shells as events (slice 2b): a naval shell drawn from its `shell_salvo`
   *  (`ShellSalvoStore.place`), not from snapshots: snapshot sync and the
   *  per-frame advance leave it alone. */
  event?: boolean;
  /** Event shells: world units flown since firing. The drawn streak trails the
   *  shell and is never longer than this (absent = no limit). */
  flown?: number;
}

/** One naval shell as its `shell_salvo` described it (game space). */
export interface ShellSalvoRenderInfo {
  /** Salvo id: every shell one firer fired with one gun in one tick. */
  s: number;
  /** Fire tick and flight length in ticks (`shellPathEndTick` = t + n + 1). */
  t: number;
  n: number;
  /** Origin (quantised spawn point). */
  x0: number;
  y0: number;
  /** The shell's own radius (its gun's), for the impact burst size. */
  wr: number;
  /** Velocity (u/s), owner on the wire and gun, for drawing it. */
  vx: number;
  vy: number;
  o: string;
  w: string;
  /** The hit (`shell_end`): its tick and point, or `endTick` -1 while flying. */
  endTick: number;
  ex: number;
  ey: number;
}
