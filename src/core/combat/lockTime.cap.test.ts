/**
 * testMode `lockTimeCapS` — the cap math (`capLockSeconds`): no non-player
 * lock takes longer than the cap inside lock range (1 km, owner 2026-11-21);
 * a shooter with no weapon, or a target past lock range, stays unable to
 * lock; no cap leaves the rules untouched.
 */
import { describe, it, expect } from 'vitest';
import { capLockSeconds, lockSeconds, type LockInputs } from './lockTime.js';
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
    expect(capLockSeconds(s, i, undefined)).toBe(s);
    const far = inputs({ dx: 5000 });
    expect(capLockSeconds(Infinity, far, undefined)).toBe(Infinity);
  });

  it('a cap shortens a long lock and leaves a short one alone', () => {
    const i = inputs({});
    const s = lockSeconds(i, LOCK_TUNING);
    expect(s).toBeGreaterThan(0.5);
    expect(capLockSeconds(s, i, 0.5)).toBe(0.5);
    expect(capLockSeconds(s, i, 60)).toBe(s);
  });

  it('cap 0: zero seconds, and a lock step completes it at once', () => {
    const i = inputs({});
    const secs = capLockSeconds(lockSeconds(i, LOCK_TUNING), i, 0);
    expect(secs).toBe(0);
    const e = newLock('t', true);
    expect(stepLock(e, 0.1, secs, secs * LOCK_TUNING.failsafeMul, LOCK_TUNING.lostGraceSeconds)).toBe('locked');
    expect(e.stage).toBe('locked');
  });

  it('too slow to lock by the rules (Infinity past maxSeconds) locks in the cap', () => {
    // A capital-sized gun (refSize 1800) on a fighter (signature 10): past maxSeconds.
    const i = inputs({ refSize: 1800, tracking: 0.15, signature: 10, dx: 500 });
    expect(lockSeconds(i, LOCK_TUNING)).toBe(Infinity);
    expect(capLockSeconds(Infinity, i, 2)).toBe(2);
  });

  it('past reach but inside lock range locks in the cap too; past lock range or with no weapon never', () => {
    const i = inputs({ reach: 400, dx: 900 });
    expect(capLockSeconds(lockSeconds(i, LOCK_TUNING), i, 0)).toBe(0);
    expect(capLockSeconds(lockSeconds(i, LOCK_TUNING), i, 2)).toBeLessThanOrEqual(2);
    // Past lock range (1 km, owner 2026-11-21): the cap does not lift it.
    const far = inputs({ dx: 1200 });
    expect(capLockSeconds(lockSeconds(far, LOCK_TUNING), far, 0)).toBe(Infinity);
    // No weapon reach: never.
    expect(capLockSeconds(Infinity, inputs({ reach: 0 }), 0)).toBe(Infinity);
  });
});
