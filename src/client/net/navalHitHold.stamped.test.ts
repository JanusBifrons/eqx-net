/**
 * NavalHitHold's stamped-tick release (off-pilot event timing, slice 1/6):
 * a hit held for the drone timeline is released when the drones' read point
 * reaches the stamp of the newest snapshot tick at its arrival, or at its
 * deadline. Mock clocks only: the drone tick clock is seeded by hand.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ShellSalvoRenderInfo } from '@core/contracts/IRenderer';
import type { DamageEvent } from '@shared-types/messages';
import {
  NavalHitHold, STAMPED_HOLD_MARGIN_MS, matchedHoldMs, swarmReadPointMs,
  type HeldDamage, type HeldDamageSink,
} from './navalHitHold.js';
import {
  getSwarmDisplayDelayMs, resetSwarmTickClock, setSwarmDisplayDelayMs, setSwarmDisplaySpeed,
  swarmArrivalStampMs,
} from './swarmInterpolation.js';

const TICK = 100;
const ARRIVE_WALL = 10_000;
const GAME0 = 50_000;

function dmg(targetId: string, newHealth = 50, hitX = 100, hitY = 0): DamageEvent {
  return {
    type: 'damage', targetId, damage: 10, newHealth, shooterId: 'p1',
    newShield: 0, shieldMax: 0, hullMax: 100, hitLayer: 'hull', hitX, hitY,
  };
}

class Sink implements HeldDamageSink {
  readonly got: string[] = [];
  applyHeldDamage(h: HeldDamage): void { this.got.push(h.evt.targetId); }
}

/** A live, unended shell from (0, 0) along +x through (100, 0). */
function shells(): Map<string, ShellSalvoRenderInfo> {
  return new Map([['s1', {
    s: 1, t: 0, n: 60, x0: 0, y0: 0, wr: 2, vx: 600, vy: 0, o: 'p1', w: 'gun', endTick: -1, ex: 0, ey: 0,
  }]]);
}

describe('NavalHitHold stamped release', () => {
  let hold: NavalHitHold;
  let sink: Sink;
  let delay: number;

  beforeEach(() => {
    resetSwarmTickClock();
    setSwarmDisplaySpeed(1);
    // Seed the drone tick clock: tick TICK arrives (and is stamped) at ARRIVE_WALL.
    expect(swarmArrivalStampMs(TICK, ARRIVE_WALL)).toBe(ARRIVE_WALL);
    setSwarmDisplayDelayMs(200);
    delay = getSwarmDisplayDelayMs();
    hold = new NavalHitHold();
    sink = new Sink();
  });
  afterEach(() => { resetSwarmTickClock(); setSwarmDisplaySpeed(1); });

  it('is held until the read point reaches its tick, then released exactly once', () => {
    expect(hold.holdStamped(dmg('swarm-7'), false, TICK, ARRIVE_WALL, GAME0)).toBe(true);
    expect(hold.size).toBe(1);
    // The read point trails now by the display delay.
    expect(swarmReadPointMs(ARRIVE_WALL)).toBe(ARRIVE_WALL - delay);
    hold.release(-1, GAME0, sink, swarmReadPointMs(ARRIVE_WALL));
    hold.release(-1, GAME0 + delay - 1, sink, swarmReadPointMs(ARRIVE_WALL + delay - 1));
    expect(sink.got).toEqual([]);
    hold.release(-1, GAME0 + delay, sink, swarmReadPointMs(ARRIVE_WALL + delay));
    expect(sink.got).toEqual(['swarm-7']);
    hold.release(-1, GAME0 + delay + 10, sink, swarmReadPointMs(ARRIVE_WALL + delay + 10));
    expect(sink.got).toEqual(['swarm-7']);
    expect(hold.size).toBe(0);
  });

  it('a shell display tick never releases a stamped hit', () => {
    hold.holdStamped(dmg('swarm-7'), false, TICK, ARRIVE_WALL, GAME0);
    hold.release(Number.POSITIVE_INFINITY, GAME0, sink);
    expect(sink.got).toEqual([]);
  });

  it('is released by its deadline when the read point stalls', () => {
    hold.holdStamped(dmg('swarm-7'), false, TICK, ARRIVE_WALL, GAME0);
    const deadline = GAME0 + Math.min(delay + STAMPED_HOLD_MARGIN_MS, matchedHoldMs(false));
    const stalled = swarmReadPointMs(ARRIVE_WALL);
    hold.release(-1, deadline - 1, sink, stalled);
    hold.release(-1, deadline - 1, sink); // no read point this frame
    expect(sink.got).toEqual([]);
    hold.release(-1, deadline, sink, stalled);
    expect(sink.got).toEqual(['swarm-7']);
  });

  it('the deadline is capped by matchedHoldMs (pilot and off pilot)', () => {
    expect(STAMPED_HOLD_MARGIN_MS).toBe(1100);
    hold.holdStamped(dmg('a'), false, TICK, ARRIVE_WALL, GAME0);
    hold.holdStamped(dmg('b'), false, TICK, ARRIVE_WALL, GAME0, true);
    // Small delay: both wait delay + margin (under either cap).
    hold.release(-1, GAME0 + delay + STAMPED_HOLD_MARGIN_MS - 1, sink, Number.NaN);
    expect(sink.got).toEqual([]);
    hold.release(-1, GAME0 + delay + STAMPED_HOLD_MARGIN_MS, sink, Number.NaN);
    expect(sink.got.sort()).toEqual(['a', 'b']);
  });

  it('is not held before the drone tick clock is seeded', () => {
    resetSwarmTickClock();
    expect(hold.holdStamped(dmg('swarm-7'), false, TICK, ARRIVE_WALL, GAME0)).toBe(false);
    expect(hold.size).toBe(0);
  });

  it('flush releases it; flushTarget releases only its target', () => {
    hold.holdStamped(dmg('a'), false, TICK, ARRIVE_WALL, GAME0);
    hold.holdStamped(dmg('b'), false, TICK, ARRIVE_WALL, GAME0);
    hold.flushTarget('a', sink);
    expect(sink.got).toEqual(['a']);
    expect(hold.size).toBe(1);
    hold.flush(sink);
    expect(sink.got).toEqual(['a', 'b']);
    expect(hold.size).toBe(0);
  });

  it('holdsKill sees a stamped killing hit', () => {
    hold.holdStamped(dmg('swarm-7', 0), false, TICK, ARRIVE_WALL, GAME0);
    hold.holdStamped(dmg('swarm-8', 40), false, TICK, ARRIVE_WALL, GAME0);
    expect(hold.holdsKill('swarm-7')).toBe(true);
    expect(hold.holdsKill('swarm-8')).toBe(false);
  });

  it('shell matching ignores stamped hits (onShellEnd, releaseHitAt)', () => {
    hold.holdStamped(dmg('swarm-7'), false, TICK, ARRIVE_WALL, GAME0);
    // A shell_end at the same point does not give it a hit tick ...
    hold.onShellEnd(5, 100, 0, GAME0);
    hold.release(10, GAME0, sink, swarmReadPointMs(ARRIVE_WALL));
    expect(sink.got).toEqual([]);
    // ... and a beam at the same point does not release it.
    expect(hold.releaseHitAt('swarm-7', 100, 0, sink)).toBe(false);
    expect(hold.size).toBe(1);
  });

  it('a pooled entry reused for a shell hit is not stamped (read point never releases it)', () => {
    hold.holdStamped(dmg('swarm-7'), false, TICK, ARRIVE_WALL, GAME0);
    hold.flush(sink);
    expect(hold.maybeHold(dmg('ship-1'), false, shells(), GAME0)).toBe(true);
    hold.release(-1, GAME0, sink, Number.POSITIVE_INFINITY);
    expect(sink.got).toEqual(['swarm-7']);
    hold.onShellEnd(5, 100, 0, GAME0);
    hold.release(5, GAME0, sink, Number.NaN);
    expect(sink.got).toEqual(['swarm-7', 'ship-1']);
  });
});
