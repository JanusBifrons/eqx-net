/**
 * Warp travel decisions: entering the run hides the ship and lands it clear of
 * a blocked drop point; leaving the run shows it again, marks it "just
 * arrived" and re-seeds the pilot's prediction only when it was moved.
 */
import { describe, it, expect } from 'vitest';
import { ARRIVED_TICKS, WarpTravelTracker, type WarpTravelHooks } from './warpTravel.js';

function harness(clear: (x: number, y: number) => { x: number; y: number }) {
  let phase: 0 | 1 | 2 = 0;
  const log: string[] = [];
  const hooks: WarpTravelHooks = {
    phaseOf: () => phase,
    clearPointNear: (_p, x, y) => clear(x, y),
    retarget: (_p, x, y) => log.push(`retarget ${x},${y}`),
    setTravelling: (_p, on) => log.push(`travelling ${on}`),
    bumpPoseEpoch: () => log.push('epoch'),
  };
  const t = new WarpTravelTracker(hooks);
  return { t, log, set: (p: 0 | 1 | 2) => { phase = p; } };
}

describe('WarpTravelTracker', () => {
  it('a clear drop point: travel, then arrive with no retarget and no re-seed', () => {
    const { t, log, set } = harness((x, y) => ({ x, y }));
    t.noteRequest('p', 1000, 0);
    set(1); t.tick(1);
    expect(t.isTravelling('p')).toBe(false);
    set(2); t.tick(2);
    expect(t.isTravelling('p')).toBe(true);
    expect(t.interestPoint('p')).toEqual({ x: 1000, y: 0 });
    set(0); t.tick(3);
    expect(t.isTravelling('p')).toBe(false);
    expect(t.arrivedRecently('p', 3)).toBe(true);
    expect(t.arrivedRecently('p', 3 + ARRIVED_TICKS)).toBe(false);
    expect(log).toEqual(['travelling true', 'travelling false']);
  });

  it('a blocked drop point: the run is retargeted and the pilot re-seeded on landing', () => {
    const { t, log, set } = harness((x, y) => ({ x: x + 300, y }));
    t.noteRequest('p', 1000, 0);
    set(2); t.tick(1);
    expect(t.interestPoint('p')).toEqual({ x: 1300, y: 0 });
    set(0); t.tick(2);
    expect(log).toEqual(['travelling true', 'retarget 1300,0', 'travelling false', 'epoch']);
  });

  it('forgets an idle pilot once the arrival window has passed', () => {
    const { t, set } = harness((x, y) => ({ x, y }));
    t.noteRequest('p', 1000, 0);
    set(2); t.tick(1);
    set(0); t.tick(2);
    t.tick(2 + ARRIVED_TICKS);
    expect(t.arrivedRecently('p', 2)).toBe(false);
    expect(t.interestPoint('p')).toBeNull();
  });
});
