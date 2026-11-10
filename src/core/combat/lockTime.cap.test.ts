/**
 * testMode `lockTimeCapS` — the cap math (`capLockSeconds`): no non-player
 * lock takes longer than the cap while the target is in reach; out of reach
 * stays unlockable; no cap leaves the rules untouched.
 */
import { describe, it, expect } from 'vitest';
import { capLockSeconds, lockInReach, lockSeconds, type LockInputs } from './lockTime.js';
import { newLock, stepLock } from './lockState.js';
import { LOCK_TUNING } from '../../shared-types/combat/lockProfile.js';

function inputs(over: Partial<LockInputs>): LockInputs {
  return {
    refSize: 40, tracking: 2.5, reach: 1000, sensor: 1, pilotSpeed: 1,
    signature: 40, dx: 300, dy: 0, dvx: 0, dvy: 0,
    ...over,
  };
}

describe('capLockSeconds (testMode lockTimeCapS)', () => {
  it('no cap: the rules are unchanged', () => {
    const i = inputs({});
    const s = lockSeconds(i, LOCK_TUNING);
    expect(capLockSeconds(s, i, LOCK_TUNING, undefined)).toBe(s);
    const far = inputs({ dx: 5000 });
    expect(capLockSeconds(Infinity, far, LOCK_TUNING, undefined)).toBe(Infinity);
  });

  it('a cap shortens a long lock and leaves a short one alone', () => {
    const i = inputs({});
    const s = lockSeconds(i, LOCK_TUNING);
    expect(s).toBeGreaterThan(0.5);
    expect(capLockSeconds(s, i, LOCK_TUNING, 0.5)).toBe(0.5);
    expect(capLockSeconds(s, i, LOCK_TUNING, 60)).toBe(s);
  });

  it('cap 0: zero seconds, and a lock step completes it at once', () => {
    const i = inputs({});
    const secs = capLockSeconds(lockSeconds(i, LOCK_TUNING), i, LOCK_TUNING, 0);
    expect(secs).toBe(0);
    const e = newLock('t', true);
    expect(stepLock(e, 0.1, secs, secs * LOCK_TUNING.failsafeMul, LOCK_TUNING.lostGraceSeconds)).toBe('locked');
    expect(e.stage).toBe('locked');
  });

  it('in reach but too slow to lock by the rules (Infinity past maxSeconds) locks in the cap', () => {
    // A capital-sized gun (refSize 1800) on a fighter (signature 10): past maxSeconds.
    const i = inputs({ refSize: 1800, tracking: 0.15, signature: 10, dx: 500 });
    expect(lockSeconds(i, LOCK_TUNING)).toBe(Infinity);
    expect(lockInReach(i, LOCK_TUNING)).toBe(true);
    expect(capLockSeconds(Infinity, i, LOCK_TUNING, 2)).toBe(2);
  });

  it('out of reach stays unlockable whatever the cap', () => {
    const i = inputs({ dx: 5000 });
    expect(lockInReach(i, LOCK_TUNING)).toBe(false);
    expect(capLockSeconds(lockSeconds(i, LOCK_TUNING), i, LOCK_TUNING, 0)).toBe(Infinity);
    // The reach slack still counts as in reach.
    const edge = inputs({ dx: 1000 * LOCK_TUNING.reachSlack - 1 });
    expect(capLockSeconds(lockSeconds(edge, LOCK_TUNING), edge, LOCK_TUNING, 0)).toBe(0);
    // No weapon reach: never.
    expect(capLockSeconds(Infinity, inputs({ reach: 0 }), LOCK_TUNING, 0)).toBe(Infinity);
  });
});
