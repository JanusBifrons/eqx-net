/**
 * RTS slice 10 — a command-view join. The client joined with a ship (normal
 * handshake, so the load curtain lifts the proven way); at the arrival flip the
 * server parks the hull and sends `control_mode: command`. The client must
 * enter command view and drop its predicted body + own drawn entry exactly as
 * a toggle-to-command does, and the pose-less patch that may still list the
 * hull active must not respawn a phantom (the spectate-race rule). It must
 * also send nothing back (the server already parked the hull).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import { selectControlMode, useUIStore } from '../state/store.js';
import { FLEET_ARRIVAL_SETTLE_MS } from './fleetWarpFollow.js';

type Internals = {
  room: { send: (t: string, p: unknown) => void } | null;
  predWorld: PhysicsWorld | null;
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

describe('control_mode: command (RTS slice 10 command-view join)', () => {
  beforeEach(() => useUIStore.setState({ pilotMode: 'pilot' }));
  afterEach(() => useUIStore.setState({ pilotMode: 'pilot' }));

  it('enters command view, drops the local body and drawn ship, sends nothing', async () => {
    const client = new ColyseusGameClient();
    const c = client as unknown as Internals;
    const sent: string[] = [];
    c.predWorld = await PhysicsWorld.create();
    c.room = { send: (t) => { sent.push(t); } };
    c.mirror.localPlayerId = PID;
    c.mirror.localShipInstanceId = SHIP;
    c.mirror.ships.set(PID, { x: 100, y: 0, vx: 0, vy: 0, angle: 0, kind: 'fighter' } as never);
    c.tryInitPredWorld(PID);
    expect(c.predWorld!.hasShip(PID)).toBe(true);

    client.enterCommandFromServer();

    expect(selectControlMode(useUIStore.getState())).toBe('command');
    expect(c.predWorld!.hasShip(PID)).toBe(false);
    expect(c.mirror.ships.has(PID)).toBe(false);
    expect(sent).toEqual([]);

    // A late patch still listing the hull active must not respawn a phantom.
    c.syncMirror({ ships: new Map([[SHIP, { playerId: PID, isActive: true, alive: true, kind: 'fighter' }]]) });
    expect(c.predWorld!.hasShip(PID)).toBe(false);
    expect(c.mirror.ships.has(PID)).toBe(false);
  });

  it('sendCommand sends `command` and drops the local ship', async () => {
    const client = new ColyseusGameClient();
    const c = client as unknown as Internals;
    const sent: string[] = [];
    c.predWorld = await PhysicsWorld.create();
    c.room = { send: (t) => { sent.push(t); } };
    c.mirror.localPlayerId = PID;
    c.mirror.localShipInstanceId = SHIP;
    c.mirror.ships.set(PID, { x: 100, y: 0, vx: 0, vy: 0, angle: 0, kind: 'fighter' } as never);
    c.tryInitPredWorld(PID);

    useUIStore.setState({ pilotMode: 'spectator' });
    expect(client.sendCommand()).toBe(true);
    expect(sent).toEqual(['command']);
    expect(c.predWorld!.hasShip(PID)).toBe(false);
    expect(c.mirror.ships.has(PID)).toBe(false);
  });

  // CI (rts-fleet-warp, command-view-camera): before the flip the camera follows
  // the local ship, whose drawn pose on a re-join glides in from the pose-less
  // schema (0, 0); the camera was left there, the hulls off screen, so click and
  // box select found nothing. The flip now frames the hull at its snapshot pose.
  it('frames the parked hull once its snapshot pose lands, without selecting it', async () => {
    let now = 1000;
    const client = new ColyseusGameClient({ now: () => now } as never);
    const c = client as unknown as Internals;
    c.predWorld = await PhysicsWorld.create();
    c.room = { send: () => {} };
    c.mirror.localPlayerId = PID;
    c.mirror.localShipInstanceId = SHIP;
    c.mirror.ships.set(PID, { x: -600, y: 500, vx: 0, vy: 0, angle: 0, kind: 'fighter' } as never);
    c.tryInitPredWorld(PID);

    client.enterCommandFromServer();
    expect(client.consumePendingFleetArrival(), 'not at the pre-arrival pose').toBeNull();
    const hull = c.mirror.ships.get(SHIP)!;
    hull.x = -2040; hull.y = 1800; // the next snapshot
    now += FLEET_ARRIVAL_SETTLE_MS;
    expect(client.consumePendingFleetArrival()).toEqual({ ids: [SHIP], x: -2040, y: 1800, select: false });
    expect(client.consumePendingFleetArrival(), 'one-shot').toBeNull();

    // Already in Command (idempotent re-send): no new framing.
    client.enterCommandFromServer();
    now += FLEET_ARRIVAL_SETTLE_MS;
    expect(client.consumePendingFleetArrival()).toBeNull();
  });
});
