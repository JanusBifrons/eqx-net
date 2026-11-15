/**
 * RTS Part A — seamless take controls, the client side.
 *
 * Owner requirement: taking (or letting go of) the controls of a fleet ship
 * must not flicker. The ship's mirror key changes (shipInstanceId <-> its
 * pilot's playerId). Before the fix the hull entry was DROPPED and a fresh
 * entry made under the new key, so the renderer (keyed by mirror key) threw
 * away the ship's sprite, art, turret cluster and health bar and rebuilt them.
 * Now `ColyseusClient.rekeyShip` MOVES the same entry object, its body and its
 * per-ship prediction state, and queues the pair on `mirror.pendingShipRekeys`
 * (one-frame trigger, crosses the worker boundary with the mirror) for the
 * renderer to move its state too. Covers all three hand-overs:
 *  - take controls of your own hull (the welcome re-key),
 *  - let go of them (Command), including the race before the server parks it,
 *  - another pilot taking their parked hull (snapshot first, or schema first).
 * Browser lock: tests/e2e/rts-take-controls.spec.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { useUIStore } from '../state/store.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';

type Internals = {
  room: { send: (t: string, p: unknown) => void } | null;
  predWorld: PhysicsWorld | null;
  reconciler: unknown;
  mirror: RenderMirror & { localShipInstanceId?: string | null };
  handleSnapshot(snap: SnapshotMessage): void;
  syncMirror(state: unknown): void;
  rekeyOwnShipFromHull(playerId: string, welcomeShipInstanceId: string): void;
  tryInitPredWorld(playerId: string): void;
};

const ME = 'p-me';
const SID = 'ship-me';

function snap(tick: number, states: Record<string, Record<string, unknown>>): SnapshotMessage {
  return { type: 'snapshot', serverTick: tick, ackedTick: 0, states } as unknown as SnapshotMessage;
}

async function client(): Promise<Internals & ColyseusGameClient> {
  const c = new ColyseusGameClient() as unknown as Internals & ColyseusGameClient;
  c.predWorld = await PhysicsWorld.create();
  c.mirror.localPlayerId = ME;
  return c;
}

describe('seamless take controls — the mirror entry MOVES (RTS Part A)', () => {
  beforeEach(() => useUIStore.setState({ pilotMode: 'spectator' }));
  afterEach(() => useUIStore.setState({ pilotMode: 'pilot' }));

  it('take controls: the welcome moves the SAME hull entry to the playerId and queues the re-key', async () => {
    const c = await client();
    c.mirror.ships.set(SID, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'fighter', isActive: false, ownerPlayerId: ME, mountAngles: [0.4] });
    c.handleSnapshot(snap(10, { [SID]: { x: 400, y: -120, vx: 30, vy: 0, angle: 0.3, angvel: 0, playerId: ME, isActive: false, mountAngles: [0.4] } }));
    const hullEntry = c.mirror.ships.get(SID)!;
    c.mirror.pendingShipRekeys!.length = 0;

    c.rekeyOwnShipFromHull(ME, SID);
    c.tryInitPredWorld(ME);

    expect(c.mirror.ships.get(ME), 'the same entry object, not a rebuilt one').toBe(hullEntry);
    expect(c.mirror.ships.get(ME)!.mountAngles, 'turret angles carried').toEqual([0.4]);
    expect(c.mirror.ships.has(SID)).toBe(false);
    expect(c.mirror.pendingShipRekeys, 'the renderer is told to move, not rebuild').toEqual([SID, ME]);
    expect(c.predWorld!.hasShip(SID), 'no two bodies').toBe(false);
    const local = c.predWorld!.getShipState(ME)!;
    expect(local.x).toBeCloseTo(hullEntry.x, 3);
    expect(local.vx).toBeCloseTo(hullEntry.vx, 3);
  });

  it('Command: the flown ship moves to its shipInstanceId with a remote body at its own pose, and the race snapshot keeps it', async () => {
    useUIStore.setState({ pilotMode: 'pilot' });
    const c = await client();
    c.mirror.localShipInstanceId = SID;
    c.room = { send: () => {} };
    c.mirror.ships.set(ME, { x: 4000, y: 50, vx: 120, vy: 0, angle: 0.2, kind: 'fighter', mountAngles: [0.1] });
    c.tryInitPredWorld(ME);
    const flown = c.mirror.ships.get(ME)!;
    c.mirror.pendingShipRekeys!.length = 0;

    useUIStore.setState({ pilotMode: 'spectator' });
    c.sendCommand();

    expect(c.mirror.ships.get(SID), 'the same entry, now the parked hull').toBe(flown);
    expect(c.mirror.ships.has(ME)).toBe(false);
    expect(c.mirror.pendingShipRekeys).toEqual([ME, SID]);
    expect(c.predWorld!.hasShip(ME), 'the local body is gone').toBe(false);
    expect(c.predWorld!.hasShip(SID), 'a remote body carries on at the ship').toBe(true);
    expect(c.predWorld!.getShipState(SID)!.x).toBeCloseTo(4000, 1);
    expect(c.predWorld!.getShipState(SID)!.vx).toBeCloseTo(120, 1);

    // The race: the server still lists the ship ACTIVE for a tick or more,
    // with no pose on the schema. It is neither dropped nor re-predicted.
    c.room = null;
    c.syncMirror({ ships: new Map([[SID, { playerId: ME, isActive: true, alive: true, kind: 'fighter' }]]) });
    c.handleSnapshot(snap(20, { [SID]: { x: 4006, y: 50, vx: 120, vy: 0, angle: 0.2, angvel: 0, playerId: ME, isActive: true } }));
    expect(c.mirror.ships.get(SID), 'still the same entry through the race').toBe(flown);
    expect(c.mirror.ships.has(ME), 'never a phantom own ship').toBe(false);
    expect(c.predWorld!.hasShip(ME)).toBe(false);
    // Then the server parks it.
    c.syncMirror({ ships: new Map([[SID, { playerId: ME, isActive: false, alive: true, kind: 'fighter' }]]) });
    c.handleSnapshot(snap(23, { [SID]: { x: 4010, y: 50, vx: 120, vy: 0, angle: 0.2, angvel: 0, playerId: ME, isActive: false } }));
    expect(c.mirror.ships.get(SID)).toBe(flown);
    expect(c.mirror.pendingShipRekeys, 'one move, no re-creation').toEqual([ME, SID]);
  });

  it('another pilot takes their parked hull (snapshot first): same entry and body under their playerId', async () => {
    useUIStore.setState({ pilotMode: 'pilot' });
    const c = await client();
    const B = 'p-b', BSID = 'ship-b';
    c.mirror.ships.set(BSID, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'fighter', isActive: false, ownerPlayerId: B });
    c.handleSnapshot(snap(10, { [BSID]: { x: 200, y: 300, vx: 0, vy: 0, angle: 1, angvel: 0, playerId: B, isActive: false } }));
    const entry = c.mirror.ships.get(BSID)!;
    expect(c.predWorld!.hasShip(BSID)).toBe(true);
    c.mirror.pendingShipRekeys!.length = 0;

    c.handleSnapshot(snap(13, { [BSID]: { x: 205, y: 300, vx: 0, vy: 0, angle: 1, angvel: 0, playerId: B, isActive: true } }));
    expect(c.mirror.ships.get(B), 'the same entry, under the pilot now').toBe(entry);
    expect(c.mirror.ships.has(BSID)).toBe(false);
    expect(c.mirror.pendingShipRekeys).toEqual([BSID, B]);
    expect(c.predWorld!.hasShip(B)).toBe(true);
    expect(c.predWorld!.hasShip(BSID)).toBe(false);
    // The schema catching up changes nothing.
    c.syncMirror({ ships: new Map([[BSID, { playerId: B, isActive: true, alive: true, kind: 'fighter' }]]) });
    expect(c.mirror.ships.get(B)).toBe(entry);
    expect(c.mirror.pendingShipRekeys).toEqual([BSID, B]);
  });

  it('another pilot takes their parked hull (schema first), then lets go again: one entry throughout', async () => {
    useUIStore.setState({ pilotMode: 'pilot' });
    const c = await client();
    const B = 'p-b', BSID = 'ship-b';
    c.mirror.ships.set(BSID, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'fighter', isActive: false, ownerPlayerId: B });
    c.handleSnapshot(snap(10, { [BSID]: { x: 200, y: 300, vx: 0, vy: 0, angle: 1, angvel: 0, playerId: B, isActive: false } }));
    const entry = c.mirror.ships.get(BSID)!;
    c.mirror.pendingShipRekeys!.length = 0;

    c.syncMirror({ ships: new Map([[BSID, { playerId: B, isActive: true, alive: true, kind: 'fighter' }]]) });
    expect(c.mirror.ships.get(B), 'moved, not created at the schema (0,0)').toBe(entry);
    expect(c.mirror.ships.get(B)!.x).toBeCloseTo(200, 1);
    c.handleSnapshot(snap(13, { [BSID]: { x: 205, y: 300, vx: 0, vy: 0, angle: 1, angvel: 0, playerId: B, isActive: true } }));
    expect(c.mirror.ships.get(B)).toBe(entry);

    // B lets go: back to the hull key, same entry.
    c.syncMirror({ ships: new Map([[BSID, { playerId: B, isActive: false, alive: true, kind: 'fighter' }]]) });
    expect(c.mirror.ships.get(BSID)).toBe(entry);
    expect(c.mirror.ships.has(B)).toBe(false);
    c.handleSnapshot(snap(16, { [BSID]: { x: 210, y: 300, vx: 0, vy: 0, angle: 1, angvel: 0, playerId: B, isActive: false } }));
    expect(c.mirror.ships.get(BSID)).toBe(entry);
    expect(c.mirror.pendingShipRekeys).toEqual([BSID, B, B, BSID]);
  });
});

/**
 * Turret angles across a hand-over. The entry moves, so its `mountAngles` go
 * with it; the server moves its angles in the same "ship key moved" seam
 * (`SectorRoom.shipKeyMoved`), so the next snapshot under the new key carries
 * the same angles and the turrets never snap home. Server half:
 * tests/integration/sectorRoom/handOverKeepsFleetState.test.ts.
 */
describe('seamless take controls — turret angles carry over (RTS Part A)', () => {
  beforeEach(() => useUIStore.setState({ pilotMode: 'pilot' }));

  it('another pilot takes their parked hull and lets go: the turret angles are the same throughout', async () => {
    const c = await client();
    const B = 'p-b', BSID = 'ship-b';
    const ANG = [0.4, -0.3];
    c.mirror.ships.set(BSID, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'interceptor', isActive: false, ownerPlayerId: B });
    c.handleSnapshot(snap(10, { [BSID]: { x: 200, y: 300, vx: 0, vy: 0, angle: 1, angvel: 0, playerId: B, isActive: false, mountAngles: ANG } }));
    expect(c.mirror.ships.get(BSID)!.mountAngles).toEqual(ANG);

    // Take controls: re-keyed by the snapshot, which (server seam) carries the same angles.
    c.handleSnapshot(snap(13, { [BSID]: { x: 205, y: 300, vx: 0, vy: 0, angle: 1, angvel: 0, playerId: B, isActive: true, mountAngles: ANG } }));
    expect(c.mirror.ships.get(B)!.mountAngles, 'after taking the controls').toEqual(ANG);
    c.handleSnapshot(snap(16, { [BSID]: { x: 210, y: 300, vx: 0, vy: 0, angle: 1, angvel: 0, playerId: B, isActive: true, mountAngles: ANG } }));
    expect(c.mirror.ships.get(B)!.mountAngles).toEqual(ANG);

    // Let go (schema first): the entry moves with its angles before any snapshot.
    c.syncMirror({ ships: new Map([[BSID, { playerId: B, isActive: false, alive: true, kind: 'interceptor' }]]) });
    expect(c.mirror.ships.get(BSID)!.mountAngles, 'carried by the re-key itself').toEqual(ANG);
    c.handleSnapshot(snap(19, { [BSID]: { x: 215, y: 300, vx: 0, vy: 0, angle: 1, angvel: 0, playerId: B, isActive: false, mountAngles: ANG } }));
    expect(c.mirror.ships.get(BSID)!.mountAngles).toEqual(ANG);
  });

  it('Command: the own ship\'s turret angles go with it to the AI pilot', async () => {
    const c = await client();
    c.mirror.localShipInstanceId = SID;
    c.room = { send: () => {} };
    c.mirror.ships.set(ME, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'interceptor', mountAngles: [0.25, -0.15] });
    c.tryInitPredWorld(ME);
    useUIStore.setState({ pilotMode: 'spectator' });
    c.sendCommand();
    expect(c.mirror.ships.get(SID)!.mountAngles).toEqual([0.25, -0.15]);
    useUIStore.setState({ pilotMode: 'pilot' });
  });
});
