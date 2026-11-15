/**
 * Capital live beams: only the turrets that bear on their lock draw a beam.
 *
 * Showcase `wreckResplit` (lance battlecruiser on a locked wreck piece): the
 * capital fire pass (`fcFireMounts`) fires only the mounts whose barrel bears
 * on the lock (`mountFiresOn`, the server's gate too, #15 #19), but once ANY
 * main-battery turret bore, `updateLiveBeam` drew a beam for EVERY mount of
 * the group, along each turret's current angle. A turret still training, or
 * parked at its arc limit, drew a full-length beam past the target that the
 * server never fired.
 *
 * Lock: with main-1 trained on the lock and main-2 / main-3 turned away, the
 * fire tick draws exactly main-1's beam.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { getShipKind } from '@shared-types/shipKinds';
import { weaponIdReach } from '@core/combat/mountReach';
import type { SwarmRenderState } from '@core/contracts/IRenderer';

interface Internals {
  room: { send: (type: string, msg: unknown) => void } | null;
  predWorld: unknown;
  predEnergy: number;
  inputTick: number;
  _fcGroups: ReadonlyArray<{ id: string; m: number; l: ReadonlyArray<{ t: string; s: number; p: number }> }>;
  fcFireTick: (spaceHeld: boolean) => void;
  mirror: {
    ships: Map<string, { x: number; y: number; vx: number; vy: number; angle: number; kind?: string; mountAngles?: number[] }>;
    swarm: Map<number, SwarmRenderState>;
    liveBeams?: Map<string, { dist: number }>;
    localPlayerId: string | null;
  };
}

const ME = 'me';
const KIND = 'battlecruiser-lance';
const wrap = (a: number): number => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;

describe('capital live beams draw only the turrets that bear (updateLiveBeam)', () => {
  let c: Internals;

  beforeEach(() => {
    c = new ColyseusGameClient() as unknown as Internals;
    c.room = { send: vi.fn() };
    c.predWorld = {
      getShipState: () => ({ x: 0, y: 0, angle: 0 }),
      hitscan: () => null,
    };
    c.predEnergy = 1e9;
    c.inputTick = 1000;
    c.mirror.localPlayerId = ME;
    c.mirror.swarm = new Map();
  });

  it('a main-battery turret turned away from the lock draws no beam', () => {
    const kind = getShipKind(KIND);
    const m1 = kind.mounts.find((m) => m.id === 'main-1')!;
    // A small wreck piece off the starboard bow, well inside heavy-beam reach.
    const tx = weaponIdReach('heavy_beam') * 0.5;
    const ty = m1.localY;
    c.mirror.swarm.set(1, { kind: 4, x: tx, y: ty, vx: 0, vy: 0, angle: 0, radius: 15 } as unknown as SwarmRenderState);
    const mountAngles = kind.mounts.map((m) =>
      m.id === 'main-1'
        ? wrap(Math.atan2(-(tx - m.localX), ty - m.localY) - m.baseAngle) // trained on the piece
        : 0, // at rest, facing ahead: ~90 deg off the piece
    );
    c.mirror.ships.set(ME, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: KIND, mountAngles });
    c._fcGroups = [{ id: 'main', m: 0, l: [{ t: 's:1', s: 2, p: 100 }] }];

    c.fcFireTick(false);

    expect([...(c.mirror.liveBeams?.keys() ?? [])]).toEqual(['main-1']);
  });
});
