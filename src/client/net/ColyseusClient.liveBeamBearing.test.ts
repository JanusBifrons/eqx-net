/**
 * A capital's own beam group draws a live beam only from the turrets that
 * fire. Filmed 2026-11-15 (a pilot in a lance battlecruiser, nose on its
 * target): the stern heavy-beam turret, which cannot bear forward and never
 * fired, still drew a beam straight out of the stern to the weapon's 20 km
 * range, because `updateLiveBeam` gave every mount of the firing group a beam.
 * Per-mount groups (capitals) fire each turret only when it bears on its own
 * share of the locks (`fcFireMounts`, the server's per-mount rule, #15), so
 * the beams drawn follow the same set.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { PhysicsWorld } from '../../core/physics/World.js';

interface Internals {
  updateLiveBeam(): void;
  predWorld: PhysicsWorld | null;
  /** FireControlClient internals. */
  fc: { _fcPerMount: boolean; _fireSlotOverride: string | null; _fcBearing: Set<string> };
  mirror: {
    ships: Map<string, { x: number; y: number; vx: number; vy: number; angle: number; kind?: string }>;
    liveBeams?: Map<string, unknown>;
    localPlayerId: string | null;
  };
}

describe('live beams of a per-mount (capital) group', () => {
  const LOCAL_ID = 'player-1';
  let c: Internals;

  beforeEach(async () => {
    c = new ColyseusGameClient() as unknown as Internals;
    c.predWorld = await PhysicsWorld.create();
    c.predWorld.spawnShip(LOCAL_ID, 0, 0, 'battlecruiser-lance');
    c.mirror.localPlayerId = LOCAL_ID;
    c.mirror.ships.set(LOCAL_ID, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'battlecruiser-lance' });
    c.fc._fcPerMount = true;
    c.fc._fireSlotOverride = 'main';
  });

  it('draws only the turrets that bear (the stern turret aimed away draws nothing)', () => {
    c.fc._fcBearing.add('main-1');
    c.fc._fcBearing.add('main-2');
    c.updateLiveBeam();
    expect([...c.mirror.liveBeams!.keys()].sort()).toEqual(['main-1', 'main-2']);
  });

  it('a turret that stops bearing loses its beam', () => {
    c.fc._fcBearing.add('main-1');
    c.fc._fcBearing.add('main-3');
    c.updateLiveBeam();
    c.fc._fcBearing.clear();
    c.fc._fcBearing.add('main-1');
    c.updateLiveBeam();
    expect([...c.mirror.liveBeams!.keys()]).toEqual(['main-1']);
  });
});
