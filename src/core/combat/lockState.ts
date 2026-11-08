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
}

export type LockEvent = 'none' | 'commit' | 'locked' | 'dropped';

export function newLock(target: string, hostile: boolean): LockEntry {
  return { target, stage: hostile ? 'acquiring' : 'failsafe', progress: 0, lostFor: 0 };
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
): LockEvent {
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
