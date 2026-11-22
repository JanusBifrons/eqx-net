/**
 * A mine's blast waits with its damage hit (off-pilot event timing, slice
 * 4b/6). The server sends the hit (at the mine's point) just before
 * `mine_detonated`; when that hit is held for a drone-timeline target
 * (`holdStamped`), the blast takes its stamp and both show the frame the
 * drones' read point reaches it. A pilot hull's hit (the local ship's
 * included) is not held, and its blast shows at once. Mock clocks only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { DamageEvent } from '@shared-types/messages';
import { NavalHitHold, swarmReadPointMs, type HeldDamage, type HeldDamageSink } from '../navalHitHold.js';
import {
  getSwarmDisplayDelayMs, resetSwarmTickClock, setSwarmDisplayDelayMode, setSwarmDisplayDelayMs,
  setSwarmDisplaySpeed, swarmArrivalStampMs,
} from '../swarmInterpolation.js';
import { registerImpactFxHandlers } from './impactFxHandlers.js';
import { pushBlastExplosion } from './shellHandlers.js';

// Off pilot the delay grows only after an outage; pin the value the hold
// reads instead (as `ColyseusClient.droneHitHold.test.ts`).
const delayOverride = vi.hoisted(() => ({ ms: Number.NaN }));
vi.mock('../swarmInterpolation.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../swarmInterpolation.js')>();
  return {
    ...real,
    getSwarmDisplayDelayMs: (): number =>
      (Number.isNaN(delayOverride.ms) ? real.getSwarmDisplayDelayMs() : delayOverride.ms),
  };
});

const TICK = 100;
const ARRIVE_WALL = 10_000;
const GAME0 = 50_000;
const MX = 123.5;
const MY = -40.25;
const R = 140;

function mineHit(targetId: string): DamageEvent {
  return {
    type: 'damage', targetId, damage: 260, newHealth: 40, shooterId: 'layer', hitX: MX, hitY: MY,
    newShield: 0, shieldMax: 0, hullMax: 300, hitLayer: 'hull',
  };
}

/** The client's sink: blasts to the explosion queue, hits counted. */
class Sink implements HeldDamageSink {
  hits = 0;
  constructor(private readonly mirror: RenderMirror) {}
  applyHeldDamage(h: HeldDamage): void {
    if (h.blastRadius > 0) pushBlastExplosion(this.mirror, h.evt.hitX!, h.evt.hitY!, h.blastRadius);
    else this.hits++;
  }
}

function rig(): { hold: NavalHitHold; mirror: RenderMirror; sink: Sink; fire: (msg: unknown) => void } {
  const hold = new NavalHitHold();
  const mirror: RenderMirror = { ships: new Map(), localPlayerId: 'me' };
  let cb: (msg: unknown) => void = () => {};
  const room = {
    onMessage: (type: string, fn: (msg: unknown) => void) => { if (type === 'mine_detonated') cb = fn; },
  } as unknown as Room;
  registerImpactFxHandlers(room, {
    mirror, now: () => ARRIVE_WALL, holdBlastWithHit: (x, y, r) => hold.holdBlastWithHit(x, y, r),
  });
  return { hold, mirror, sink: new Sink(mirror), fire: cb };
}

const blastMsg = { type: 'mine_detonated', x: MX, y: MY, radius: R };

describe('mine_detonated waits with its held hit', () => {
  beforeEach(() => {
    resetSwarmTickClock();
    setSwarmDisplaySpeed(1);
    expect(swarmArrivalStampMs(TICK, ARRIVE_WALL)).toBe(ARRIVE_WALL);
  });
  afterEach(() => { delayOverride.ms = Number.NaN; resetSwarmTickClock(); setSwarmDisplayDelayMode('pilot'); setSwarmDisplaySpeed(1); });

  it.each([
    ['piloting', 'pilot', 150],
    ['off pilot', 'offPilot', 2000],
  ] as const)('%s: the blast appears with the hit, when the read point reaches the stamp', (_, mode, delayMs) => {
    setSwarmDisplayDelayMode(mode);
    setSwarmDisplayDelayMs(150);
    if (mode === 'offPilot') delayOverride.ms = delayMs;
    expect(getSwarmDisplayDelayMs()).toBe(delayMs);
    const { hold, mirror, sink, fire } = rig();
    expect(hold.holdStamped(mineHit('swarm-9'), false, TICK, ARRIVE_WALL, GAME0, mode === 'offPilot')).toBe(true);
    fire(blastMsg);
    expect(mirror.pendingMissileExplosions ?? []).toEqual([]);
    // Frames until the drones' read point reaches the arrival tick: nothing.
    for (let wall = ARRIVE_WALL; wall < ARRIVE_WALL + delayMs - 1; wall += 1000 / 60) {
      hold.release(Number.NaN, GAME0 + (wall - ARRIVE_WALL), sink, swarmReadPointMs(wall));
      expect(mirror.pendingMissileExplosions ?? []).toEqual([]);
      expect(sink.hits).toBe(0);
    }
    hold.release(Number.NaN, GAME0 + delayMs, sink, swarmReadPointMs(ARRIVE_WALL + delayMs));
    expect(mirror.pendingMissileExplosions).toEqual([{ x: MX, y: MY, splashRadius: R, missileId: -1 }]);
    expect(sink.hits).toBe(1);
    expect(hold.size).toBe(0);
  });

  it('a hit that was not held (a pilot hull, the local ship) leaves the blast immediate', () => {
    const { hold, mirror, fire } = rig();
    fire(blastMsg);
    expect(mirror.pendingMissileExplosions).toEqual([{ x: MX, y: MY, splashRadius: R, missileId: -1 }]);
    expect(hold.size).toBe(0);
  });

  it('only a stamped hit at exactly the mine point carries it', () => {
    const { hold, mirror, fire } = rig();
    const elsewhere = mineHit('swarm-9');
    elsewhere.hitX = MX + 1;
    hold.holdStamped(elsewhere, false, TICK, ARRIVE_WALL, GAME0);
    fire(blastMsg);
    expect(mirror.pendingMissileExplosions).toHaveLength(1);
    expect(hold.size).toBe(1);
  });

  it('a welcome flush drops the held blast and releases the hit', () => {
    const { hold, mirror, sink, fire } = rig();
    hold.holdStamped(mineHit('swarm-9'), false, TICK, ARRIVE_WALL, GAME0);
    fire(blastMsg);
    hold.flush(sink);
    expect(mirror.pendingMissileExplosions ?? []).toEqual([]);
    expect(sink.hits).toBe(1);
    expect(hold.size).toBe(0);
  });
});
