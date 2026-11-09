/**
 * One target lock's state machine (exp/fire-control P1). Pure, alloc-free —
 * the caller owns the `LockEntry` objects and reuses them. Shared by server
 * (authority) and client (prediction), #15.
 *
 *   failsafe ──finish──▶ (COMMIT: a hostile act) ──▶ acquiring ──▶ locked
 *       │                                               │            │
 *       └── cancel = harmless                           └── out of reach for
 *                                                           `lostGrace` ──▶ dropped
 *
 * `failsafe` only runs for targets that are NOT already hostile (neutral or
 * allied); a hostile target starts in `acquiring`.
 */

export type LockStage = 'failsafe' | 'acquiring' | 'locked';

/** Wire byte for each stage (snapshot `states[].groups`). */
export const LOCK_STAGE_CODE: Record<LockStage, number> = { failsafe: 0, acquiring: 1, locked: 2 };
export const LOCK_STAGE_BY_CODE: readonly LockStage[] = ['failsafe', 'acquiring', 'locked'];

export interface LockEntry {
  /** Stable target key: 's:<entityId>' (swarm) | 'p:<playerId>' | 'h:<shipInstanceId>'. */
  target: string;
  stage: LockStage;
  /** 0..1 progress through the current ring (failsafe or acquiring). */
  progress: number;
  /** Seconds the target has been out of reach / unlockable. */
  lostFor: number;
  /**
   * How the lock is driven: COMMIT (0) runs to completion on its own (AUTO, or
   * the inspector's Lock button); HELD (1) builds only while the pilot keeps
   * the lock line on the target; RELEASED (2) was held and let go, so it drains
   * back to 0 and drops (the line coming back resumes it). Once LOCKED the
   * mode no longer matters.
   */
  track: LockTrack;
  /** AUTO picked this target itself; switching the group to MAN cancels it if not yet locked. */
  auto: boolean;
}

export const LOCK_TRACK = { commit: 0, held: 1, released: 2 } as const;
export type LockTrack = 0 | 1 | 2;

export type LockEvent = 'none' | 'commit' | 'locked' | 'dropped';

export function newLock(target: string, hostile: boolean, track: LockTrack = LOCK_TRACK.commit): LockEntry {
  return { target, stage: hostile ? 'acquiring' : 'failsafe', progress: 0, lostFor: 0, track, auto: false };
}

/**
 * Advance one lock by `dt` seconds. `lockSecs` is the current lock time
 * (Infinity = can't lock right now), `failsafeSecs` the failsafe duration.
 * Returns what happened this step.
 */
export function stepLock(
  e: LockEntry,
  dt: number,
  lockSecs: number,
  failsafeSecs: number,
  lostGrace: number,
  decayMul = 1.5,
): LockEvent {
  // Released before it finished: drain back to 0 (`decayMul`× the build
  // rate), then drop. A failsafe drained to 0 did no harm.
  if (e.track === LOCK_TRACK.released && e.stage !== 'locked') {
    const secs = e.stage === 'failsafe' ? failsafeSecs : lockSecs;
    const rate = Number.isFinite(secs) ? decayMul / Math.max(1e-6, secs) : 2;
    e.progress -= dt * rate;
    if (e.progress <= 0) return 'dropped';
    return 'none';
  }
  const unlockable = !Number.isFinite(lockSecs);
  if (unlockable) {
    e.lostFor += dt;
    if (e.lostFor >= lostGrace) return 'dropped';
    return 'none';
  }
  e.lostFor = 0;
  if (e.stage === 'failsafe') {
    e.progress += dt / Math.max(1e-6, failsafeSecs);
    if (e.progress >= 1) {
      e.stage = 'acquiring';
      e.progress = 0;
      return 'commit';
    }
    return 'none';
  }
  if (e.stage === 'acquiring') {
    e.progress += dt / Math.max(1e-6, lockSecs);
    if (e.progress >= 1) {
      e.stage = 'locked';
      e.progress = 1;
      return 'locked';
    }
  }
  return 'none';
}
