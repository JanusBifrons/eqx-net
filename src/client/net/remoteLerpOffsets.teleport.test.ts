/**
 * Netgap S2-3: another player's ship snaps on a real teleport (a jump no ship
 * could fly, or a warp run / arrival) and still glides on a correction under
 * the plausible-speed bound.
 */
import { describe, it, expect } from 'vitest';
import type { PhysicsWorld } from '@core/physics/World';
import { computeRemoteLerpOffsets, type RemoteShipOffset } from './remoteLerpOffsets.js';
import { createRemotePredictionGuard } from './remotePredictionGuard.js';
import { TELEPORT_MAX_PLAUSIBLE_SPEED } from './plausibleSpeed.js';
import type { PreResetEntry } from './snapshotRemoteSync.js';

const ID = 'R1';
const TICK_MS = 1000 / 60;
/** Three ticks between snapshots: 50 game ms, so the bound is 125 u. */
const SNAP_TICKS = 3;
const SPAN_MS = SNAP_TICKS * TICK_MS;
const BOUND_U = (TELEPORT_MAX_PLAUSIBLE_SPEED * SPAN_MS) / 1000;

interface Rig {
  offsets: Map<string, RemoteShipOffset>;
  /** Apply one snapshot whose correction moves the ship `dx` units. */
  correct(dx: number, warp?: 1 | 2 | 3, gameMsStep?: number): void;
}

function makeRig(): Rig {
  const pose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  const predWorld = { getShipState: () => pose } as unknown as PhysicsWorld;
  const preReset = new Map<string, PreResetEntry>();
  const offsets = new Map<string, RemoteShipOffset>();
  const predGuard = createRemotePredictionGuard();
  let serverTick = 1000;
  let gameNowMs = 50_000;
  const states: Record<string, { warp?: 1 | 2 | 3 }> = { [ID]: {} };
  return {
    offsets,
    correct(dx, warp, gameMsStep = SPAN_MS): void {
      serverTick += SNAP_TICKS;
      gameNowMs += gameMsStep;
      states[ID] = warp === undefined ? {} : { warp };
      // Drawn before at x = 0, physics after at x = dx.
      preReset.set(ID, { x: pose.x, y: pose.y, angle: 0 });
      pose.x += dx;
      computeRemoteLerpOffsets({ predWorld, preResetRemotePos: preReset, remoteShipOffsets: offsets, predGuard, serverTick, gameNowMs, states });
    },
  };
}

describe('other ships: teleport snap vs plausible glide (netgap S2-3)', () => {
  it('a jump just under the bound glides', () => {
    const rig = makeRig();
    rig.correct(0); // first sample: sets the span origin
    rig.correct(BOUND_U - 1);
    expect(rig.offsets.get(ID)?.sx.x).toBeCloseTo(-(BOUND_U - 1), 6);
  });

  it('a jump just over the bound snaps (offset and velocity dropped)', () => {
    const rig = makeRig();
    rig.correct(0);
    rig.correct(10); // an ordinary correction starts easing
    expect(rig.offsets.has(ID)).toBe(true);
    rig.correct(BOUND_U + 1);
    expect(rig.offsets.has(ID)).toBe(false);
  });

  it('a gap counts toward the span: a held snapshot after 400 ms glides a 500 u correction', () => {
    const rig = makeRig();
    rig.correct(0);
    rig.correct(500, undefined, 400);
    expect(rig.offsets.get(ID)?.sx.x).toBeCloseTo(-500, 6);
  });

  it('a warp arrival snaps even under the distance bound', () => {
    const rig = makeRig();
    rig.correct(0);
    rig.correct(10);
    expect(rig.offsets.has(ID)).toBe(true);
    rig.correct(20, 3);
    expect(rig.offsets.has(ID)).toBe(false);
  });

  it('the warp build-up (phase 1) still glides', () => {
    const rig = makeRig();
    rig.correct(0);
    rig.correct(20, 1);
    expect(rig.offsets.get(ID)?.sx.x).toBeCloseTo(-20, 6);
  });
});
