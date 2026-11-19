/**
 * The fleet panel's activity label for an AI pilot (RTS Part B slice 9),
 * mapped from the job `tick()` flew this tick (`HostileDroneBehaviour`
 * picks it with the same `pilotJob()` order: one source of truth).
 *
 * A warp-out run or running clear (`tickFleeClear`) ⇒ `retreating`; the
 * fight ⇒ `chasing` (target beyond its fire range) or `attacking`; travel ⇒
 * `moving` (`patrolling` on a patrol leg; it stays so while a non-fighting
 * leg or a broadside capital's route fires on the move); a flock ⇒
 * `guarding` once with its pack, else `moving`; a course ⇒ `moving` until it
 * arrives (`idle` there), a course onto its post reads as the post; a post ⇒
 * `guarding` (`moving` while flying back to it); a hunt ⇒ `searching`; the
 * orbit ⇒ `idle`. Hold fire picks no target, so it reports the job.
 *
 * Pure and allocation-free (called per fleet-status read).
 */
import type { AiShipActivity } from '../contracts/IAiBehaviour.js';
import { JOB_COURSE, JOB_FLOCK, JOB_GUARD, JOB_LEAVING, JOB_SEARCH, JOB_TRAVEL, type PilotJobId } from './tactics/manoeuvre.js';

/** The guard post (`GuardReturn`): on, centre and radius. */
export interface ActivityPost { readonly on: boolean; readonly x: number; readonly y: number; readonly r: number }

/** What the brain flew this tick, as read by `pilotActivity`: one scratch
 *  object the brain owns and refills (no per-read allocation, #14). */
export class ActivityTick {
  /** `pilotJob(JOB_ORDER_TICK)`, or the no-flock job when the leader was lost. */
  job: PilotJobId = JOB_LEAVING;
  /** This tick ran clear of a fight (`tickFleeClear`). Cleared each tick. */
  fleeing = false;
  /** This tick flew the fight (`tickCombat`), not a peacetime job. Cleared each tick. */
  fought = false;
  /** The fight's target is beyond this ship's fire range. */
  outOfRange = false;
  /** The travel leg is a patrol (fights on the way). */
  travelFights = false;
  withPack = false;
  /** This ship's position at the start of the tick. */
  x = 0;
  y = 0;
  post: ActivityPost = { on: false, x: 0, y: 0, r: 0 };
  moveTarget: { readonly x: number; readonly y: number } | null = null;
  /** Arrival radius of a course (`shipTuning(kind).wingmanArrive`). */
  arrive = 0;
}

export function pilotActivity(t: ActivityTick): AiShipActivity {
  if (t.job === JOB_LEAVING || t.fleeing) return 'retreating';
  if (t.fought) return t.outOfRange ? 'chasing' : 'attacking';
  switch (t.job) {
    case JOB_TRAVEL: return t.travelFights ? 'patrolling' : 'moving';
    // With its pack (RTS squads / escorts): guarding once it is close.
    case JOB_FLOCK: return t.withPack ? 'guarding' : 'moving';
    case JOB_SEARCH: return 'searching';
    case JOB_GUARD: return postActivity(t.x, t.y, t.post);
    case JOB_COURSE: {
      const mt = t.moveTarget!;
      const g = t.post;
      // A course onto the post is the post held (`PatrolMode`).
      if (g.on && mt.x === g.x && mt.y === g.y) return postActivity(t.x, t.y, g);
      const dx = t.x - mt.x, dy = t.y - mt.y;
      return dx * dx + dy * dy > t.arrive * t.arrive ? 'moving' : 'idle';
    }
    default: return 'idle';
  }
}

/** At the guard post (inside its radius) ⇒ `guarding`, else `moving`. */
function postActivity(x: number, y: number, g: ActivityPost): AiShipActivity {
  const dx = x - g.x, dy = y - g.y;
  return dx * dx + dy * dy > g.r * g.r ? 'moving' : 'guarding';
}
