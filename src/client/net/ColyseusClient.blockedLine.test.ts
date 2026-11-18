/**
 * Fire control's blocked-line hold, the client mirror (#15, #19;
 * fire-control.md "Blocked line hold"): the server holds a beam mount whose
 * line to its lock has been blocked for the tolerance, so the client's fire
 * pass must not draw the predicted beam (or send the shot) there either; a
 * brief block changes nothing, and the beam is back the moment the line clears.
 *
 * Own interceptor (two beam wing mounts, one slot) locked on a drone 300 u
 * ahead; the first-hit ray (`DisplayPoseHitscan` over the predWorld) is
 * stubbed to report a rock on the line or the target.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { BLOCKED_LINE_HOLD_MS } from '@core/combat/blockedLineHold';
import type { SwarmRenderState } from '@core/contracts/IRenderer';

interface Internals {
  room: { send: (type: string, msg: unknown) => void } | null;
  predWorld: unknown;
  predEnergy: number;
  inputTick: number;
  gameClock: { now: () => number };
  _fcGroups: ReadonlyArray<{ id: string; m: number; l: ReadonlyArray<{ t: string; s: number; p: number }> }>;
  _fcLastFireMs: Map<string, number>;
  _swarmBodyKeyCache: Map<number, string>;
  sendFire: (tick: number) => void;
  updateLiveBeam: () => void;
  fcFireTick: (spaceHeld: boolean) => void;
  fcMountBears: (mountId: string, weaponId: string, size: undefined, ox: number, oy: number, angle: number) => boolean;
  mirror: {
    ships: Map<string, { x: number; y: number; vx: number; vy: number; angle: number; kind?: string; mountAngles?: number[] }>;
    swarm: Map<number, SwarmRenderState>;
    localPlayerId: string | null;
  };
}

const ME = 'me';
const TY = 300; // inside the beam's 375 u reach

describe('client fire pass: the blocked-line hold mirror', () => {
  let c: Internals;
  let rock: boolean;
  let now: number;
  let beams: number;
  let sends: number;

  beforeEach(() => {
    c = new ColyseusGameClient() as unknown as Internals;
    rock = false;
    now = 10_000;
    beams = 0;
    sends = 0;
    c.room = { send: vi.fn() };
    c.predWorld = {
      getShipState: () => ({ x: 0, y: 0, angle: 0 }),
      // The predWorld first-hit ray: the rock half way, else the target.
      hitscan: () => (rock ? { hitId: 'swarm-9', dist: TY / 2 } : { hitId: 'swarm-1', dist: TY - 20 }),
    };
    c.gameClock = { now: () => now };
    c.predEnergy = 1e9;
    c.inputTick = 1000;
    c.mirror.localPlayerId = ME;
    c.mirror.ships.set(ME, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'interceptor', mountAngles: [0, 0] });
    c.mirror.swarm = new Map([[1, { kind: 1, shipKind: 'fighter', x: 0, y: TY, vx: 0, vy: 0, angle: 0, radius: 12 } as unknown as SwarmRenderState]]);
    c._swarmBodyKeyCache.set(1, 'swarm-1');
    c._fcGroups = [{ id: 'primary', m: 0, l: [{ t: 's:1', s: 2, p: 100 }] }];
    c.sendFire = () => { sends++; };
    c.updateLiveBeam = () => { beams++; };
  });

  /** One fire pass at game time `t`: did it draw the beam / send the shot? */
  function pass(t: number): { beam: boolean; sent: boolean } {
    now = t;
    c._fcLastFireMs.clear();
    const b = beams, s = sends;
    c.fcFireTick(false);
    return { beam: beams > b, sent: sends > s };
  }

  it('a clear line draws the beam and fires', () => {
    expect(pass(10_000)).toEqual({ beam: true, sent: true });
  });

  it('a blocked line keeps firing for the tolerance, then draws no beam and sends nothing', () => {
    rock = true;
    expect(pass(10_000), 'blocked, inside the tolerance').toEqual({ beam: true, sent: true });
    expect(pass(10_000 + BLOCKED_LINE_HOLD_MS / 2), 'a brief block changes nothing').toEqual({ beam: true, sent: true });
    expect(pass(10_000 + BLOCKED_LINE_HOLD_MS), 'held').toEqual({ beam: false, sent: false });
    // The per-mount ghost gate agrees.
    expect(c.fcMountBears('wing-l', 'hitscan', undefined, -8, 2, 0)).toBe(false);
    rock = false;
    expect(pass(10_000 + BLOCKED_LINE_HOLD_MS + 16), 'the line clears: fire resumes at once').toEqual({ beam: true, sent: true });
  });
});
