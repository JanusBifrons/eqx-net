/**
 * Swept drones and scrap stay until drawn out (off-pilot event timing, slice
 * 5/6; docs/architecture/shell-events.md "Stamped release"). A drone or scrap
 * piece that leaves with no destroy (scrap picked up or expired, a drone
 * leaving) was removed by the decoder's full-snapshot sweep on arrival,
 * while it was still drawn a display delay in the past (100-150 ms piloting,
 * up to ~4 s off pilot). Owner decision 2026-11-22: what disappears lines up
 * with what is drawn, in every view.
 *
 * Contract: the sweep asks `DrawnShellTiming.linger`; a moving kind is kept
 * until the drones' read point passes its newest sample (`latestArrivalMs`),
 * then the per-frame `place` removes it, once; safety bound
 * `stampedHoldDeadlineMs`; welcome and sector reset drop it. Mock clocks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import {
  SWARM_FLAG_FULL, SWARM_HEADER_BYTES, SWARM_KIND_DRONE, SWARM_KIND_SCRAP, SWARM_RECORD_BYTES,
  SWARM_REC_RADIUS_OFF, SWARM_WIRE_VERSION,
} from '@shared-types/swarmWireFormat';
import { decodeSwarmPacket } from './BinarySwarmDecoder.js';
import { DrawnShellTiming, type DrawnShellTimingHost } from './drawnShellTiming.js';
import { NavalHitHold, STAMPED_HOLD_MARGIN_MS, type HeldDamageSink } from './navalHitHold.js';
import type { ShellSalvoStore } from './shellSalvoStore.js';
import {
  getSwarmDisplayDelayMs, resetSwarmTickClock, setSwarmDisplayDelayMode, setSwarmDisplayDelayMs,
  setSwarmDisplaySpeed, swarmArrivalStampMs,
} from './swarmInterpolation.js';

// Off pilot, reaching a 2 s delay takes a simulated outage; pin the value
// the sweep reads instead (it only reads it, never sizes it).
const delayOverride = vi.hoisted(() => ({ ms: Number.NaN }));
vi.mock('./swarmInterpolation.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./swarmInterpolation.js')>();
  return {
    ...real,
    getSwarmDisplayDelayMs: (): number =>
      (Number.isNaN(delayOverride.ms) ? real.getSwarmDisplayDelayMs() : delayOverride.ms),
  };
});

const WALL0 = 50_000;
const GAME0 = 9_000;
const TICK = 1000;
const SCRAP = 5;
const DRONE = 6;

/** A swarm packet: ids with their kinds (layout as `BinarySwarmDecoder.test.ts`). */
function packet(tick: number, full: boolean, ents: Array<[number, number]>): Uint8Array {
  const buf = new ArrayBuffer(SWARM_HEADER_BYTES + ents.length * SWARM_RECORD_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, SWARM_WIRE_VERSION);
  v.setUint8(1, full ? SWARM_FLAG_FULL : 0);
  v.setUint16(2, ents.length, true);
  v.setUint32(4, tick, true);
  let off = SWARM_HEADER_BYTES;
  for (const [id, kind] of ents) {
    v.setUint16(off, id, true);
    v.setUint8(off + 2, kind);
    v.setFloat32(off + SWARM_REC_RADIUS_OFF, 10, true);
    off += SWARM_RECORD_BYTES;
  }
  return new Uint8Array(buf);
}

describe('swept drones and scrap stay until drawn out', () => {
  let mirror: RenderMirror;
  let wall: number;
  let game: number;
  let timing: DrawnShellTiming;
  let delay: number;

  const decode = (tick: number, ents: Array<[number, number]>, full = true): void =>
    decodeSwarmPacket(packet(tick, full, ents), mirror, wall, true, timing);
  /** One frame at wall `t` (shells not as events). */
  const frame = (t: number): void => { wall = t; timing.place(Number.NaN, t); };
  const has = (id: number): boolean => mirror.swarm?.has(id) === true;

  beforeEach(() => {
    resetSwarmTickClock();
    setSwarmDisplaySpeed(1);
    setSwarmDisplayDelayMode('pilot');
    mirror = { ships: new Map(), localPlayerId: 'me' } as RenderMirror;
    wall = WALL0;
    game = GAME0;
    const hold = new NavalHitHold();
    const sink: HeldDamageSink = { applyHeldDamage: () => undefined };
    const store = { clear: () => undefined, map: new Map() } as unknown as ShellSalvoStore;
    const host: DrawnShellTimingHost = {
      mirror: () => mirror, store: () => store, hold: () => hold, sink: () => sink,
      shellEvents: () => false, now: () => game, wallNow: () => wall, anchorTick: () => TICK,
      killSwarmEntity: () => undefined, killEntity: () => undefined, despawnLinger: () => undefined,
    };
    timing = new DrawnShellTiming(host);
    // Seed the drone tick clock: tick TICK is stamped at WALL0.
    expect(swarmArrivalStampMs(TICK, WALL0)).toBe(WALL0);
    setSwarmDisplayDelayMs(150);
    delay = getSwarmDisplayDelayMs();
    expect(delay).toBeGreaterThanOrEqual(100);
    decode(TICK, [[SCRAP, SWARM_KIND_SCRAP], [DRONE, SWARM_KIND_DRONE]]);
    expect(mirror.swarm?.get(SCRAP)?.latestArrivalMs).toBe(WALL0);
  });
  afterEach(() => {
    delayOverride.ms = Number.NaN;
    setSwarmDisplayDelayMode('pilot');
    resetSwarmTickClock();
    setSwarmDisplaySpeed(1);
  });

  it('piloting: scrap picked up while drawn ~150 ms behind stays until the read point passes its last sample, then goes once', () => {
    // The next full snapshot no longer lists the scrap (picked up).
    wall = WALL0 + 50;
    decode(TICK + 3, [[DRONE, SWARM_KIND_DRONE]]);
    expect(has(SCRAP)).toBe(true);
    frame(WALL0 + delay - 1);
    expect(has(SCRAP)).toBe(true);
    frame(WALL0 + delay);
    expect(has(SCRAP)).toBe(false);
    expect(timing.swarmKills.size).toBe(0);
    expect(timing.pending).toBe(false);
    // Once: a new entity on the recycled id later is not touched.
    decode(TICK + 20, [[SCRAP, SWARM_KIND_SCRAP], [DRONE, SWARM_KIND_DRONE]]);
    frame(WALL0 + delay + 500);
    expect(has(SCRAP)).toBe(true);
    expect(has(DRONE)).toBe(true);
  });

  it('off pilot: a drone leaving while drawn 2 s behind stays the 2 s', () => {
    setSwarmDisplayDelayMode('offPilot');
    delayOverride.ms = 2000;
    wall = WALL0 + 50;
    decode(TICK + 3, [[SCRAP, SWARM_KIND_SCRAP]]);
    expect(has(DRONE)).toBe(true);
    game += 1999;
    frame(WALL0 + 1999);
    expect(has(DRONE)).toBe(true);
    game += 1;
    frame(WALL0 + 2000);
    expect(has(DRONE)).toBe(false);
  });

  it('an entity the read point already passed is swept at once (as before)', () => {
    wall = WALL0 + delay;
    decode(TICK + 9, [[DRONE, SWARM_KIND_DRONE]]);
    expect(has(SCRAP)).toBe(false);
    expect(timing.swarmKills.size).toBe(0);
  });

  it('one that comes back in a later snapshot is not removed', () => {
    wall = WALL0 + 50;
    decode(TICK + 3, [[DRONE, SWARM_KIND_DRONE]]);
    wall = WALL0 + 60;
    decode(TICK + 4, [[SCRAP, SWARM_KIND_SCRAP], [DRONE, SWARM_KIND_DRONE]], false);
    frame(WALL0 + delay + 200);
    expect(has(SCRAP)).toBe(true);
    expect(timing.swarmKills.size).toBe(0);
  });

  it('a read point that never gets there falls to the deadline (delay + margin, game ms)', () => {
    wall = WALL0 + 50;
    decode(TICK + 3, [[DRONE, SWARM_KIND_DRONE]]);
    const deadline = GAME0 + delay + STAMPED_HOLD_MARGIN_MS;
    game = deadline - 1;
    timing.place(Number.NaN, Number.NaN);
    expect(has(SCRAP)).toBe(true);
    game = deadline;
    timing.place(Number.NaN, Number.NaN);
    expect(has(SCRAP)).toBe(false);
    expect(timing.swarmKills.size).toBe(0);
  });

  it('a welcome and a sector reset drop lingering entities', () => {
    wall = WALL0 + 50;
    decode(TICK + 3, []);
    expect(has(SCRAP) && has(DRONE)).toBe(true);
    timing.onWelcome(false, undefined);
    expect(has(SCRAP) || has(DRONE)).toBe(false);
    expect(timing.swarmKills.size).toBe(0);

    decode(TICK + 4, [[SCRAP, SWARM_KIND_SCRAP]]);
    wall = WALL0 + 60;
    decode(TICK + 5, []);
    expect(has(SCRAP)).toBe(true);
    timing.reset();
    expect(has(SCRAP)).toBe(false);
    expect(timing.swarmKills.size).toBe(0);
  });
});
