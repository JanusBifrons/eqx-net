/**
 * Spectate race: between `sendSpectate` (which despawns the local predicted
 * body at once) and the server's `isActive=false` patch, a schema patch still
 * lists the pilot's own hull as ACTIVE, with no pose (x/y default 0).
 * `syncMirror` must not take that as "my ship, not yet predicted" and respawn
 * it: the phantom sat at (0, 0) for the whole capital-breakup take and a
 * `'local'` camera cue followed it instead of the parked hull (2026-11-12).
 * Browser lock: tests/e2e/spectate-no-phantom-own-ship.spec.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import { useUIStore } from '../state/store.js';

type Internals = {
  room: { send: (t: string, p: unknown) => void } | null;
  predWorld: PhysicsWorld | null;
  reconciler: unknown;
  mirror: {
    localPlayerId: string | null;
    localShipInstanceId?: string | null;
    ships: Map<string, { x: number; y: number }>;
  };
  syncMirror(state: unknown): void;
  tryInitPredWorld(playerId: string): void;
};

const PID = 'pilot-1';
const SHIP = 'ship-1';

/** A schema patch with the own hull still ACTIVE and no pose on it. */
function activePatch(): unknown {
  return { ships: new Map([[SHIP, { playerId: PID, isActive: true, alive: true, kind: 'heavy-cruiser' }]]) };
}

describe('Spectate: the own hull is never re-predicted from a pose-less patch', () => {
  beforeEach(() => useUIStore.setState({ pilotMode: 'pilot' }));
  afterEach(() => useUIStore.setState({ pilotMode: 'pilot' }));

  it('the active patch that lands after Spectate neither respawns the body nor draws the ship', async () => {
    const client = new ColyseusGameClient();
    const c = client as unknown as Internals;
    c.predWorld = await PhysicsWorld.create();
    c.room = { send: () => {} };
    c.mirror.localPlayerId = PID;
    c.mirror.localShipInstanceId = SHIP;
    c.mirror.ships.set(PID, { x: 4000, y: 0, vx: 0, vy: 0, angle: 0, kind: 'heavy-cruiser' } as never);
    c.tryInitPredWorld(PID);
    expect(c.predWorld!.hasShip(PID), 'piloting: the local body exists').toBe(true);

    // The toggle's order (PilotSpectatorToggle): flip the mode, then send.
    useUIStore.setState({ pilotMode: 'spectator' });
    client.sendSpectate();
    expect(c.predWorld!.hasShip(PID)).toBe(false);
    expect(c.mirror.ships.has(PID), 'the parked hull is no longer drawn as the pilot ship').toBe(false);

    c.syncMirror(activePatch());
    expect(c.predWorld!.hasShip(PID), 'no predicted phantom of the parked hull').toBe(false);
    expect(c.mirror.ships.has(PID), 'no own mirror.ships entry while spectating').toBe(false);
  });

  it('while piloting, the same patch still bootstraps the own ship (pending-join path unchanged)', async () => {
    const client = new ColyseusGameClient();
    const c = client as unknown as Internals;
    c.predWorld = await PhysicsWorld.create();
    c.mirror.localPlayerId = PID;
    c.mirror.localShipInstanceId = SHIP;
    c.syncMirror(activePatch());
    expect(c.mirror.ships.has(PID)).toBe(true);
    expect(c.predWorld!.hasShip(PID)).toBe(true);
  });
});
