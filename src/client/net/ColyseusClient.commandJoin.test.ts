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
});
