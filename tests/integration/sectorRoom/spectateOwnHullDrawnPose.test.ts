/**
 * Spectate: the client must not keep a phantom of its own parked hull.
 *
 * Reported (hostile review of the filmed `capital-turrets` take, 2026-11-12,
 * room `showcase-capital-duel`): after `ctx.spectate()` the pilot's own heavy
 * cruiser was drawn at exactly (329.96, -33.26) on every frame of the 15 s
 * take, about 3,670 u from its (4000, 0) spawn and ~170 u inside the NPC
 * battleship at the origin, while the battleship moved and turned.
 *
 * Measured on the server (this file's first case): the parked hull never
 * leaves (4000, 0). The phantom is client-side. Spectate flips the schema
 * entry to `isActive=false`; `ColyseusClient.syncMirror` still treated the
 * player's OWN inactive entry as a pending join (the pre-welcome exemption),
 * found no predWorld body (`sendSpectate` had just despawned it), so it wrote
 * `mirror.ships[localId]` from the schema entry, which carries NO pose (x/y
 * default to 0), and `tryInitPredWorld` respawned a predicted local cruiser at
 * the world origin with a fresh Reconciler. No snapshot ever corrects it
 * (the own parked entry is routed to `lingeringShips` while spectating), so it
 * sat frozen inside the battleship.
 *
 * The bug lives at the wire boundary (a real schema patch without a pose), so
 * the client half runs the REAL `ColyseusGameClient` mirror path fed the REAL
 * room state and snapshots from a booted server (invariant #13).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { SHOWCASE_CAPITAL_DUEL_OPTS } from '../../../src/server/rooms/showcaseRooms.js';
import { slotBase, SLOT_X_OFF, SLOT_Y_OFF } from '../../../src/shared-types/sabLayout.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';
import { ColyseusGameClient } from '../../../src/client/net/ColyseusClient.js';
import { PhysicsWorld } from '../../../src/core/physics/World.js';
import { useUIStore } from '../../../src/client/state/store.js';

type Pose = { x: number; y: number };

interface ClientInternals {
  predWorld: PhysicsWorld | null;
  reconciler: unknown;
  room: unknown;
  mirror: {
    localPlayerId: string | null;
    localShipInstanceId?: string | null;
    ships: Map<string, Pose & { vx: number; vy: number; angle: number; kind?: string }>;
    lingeringShips?: Map<string, Pose & { ownerPlayerId?: string }>;
    swarm?: Map<number, unknown>;
  };
  syncMirror(state: unknown): void;
  handleSnapshot(snap: SnapshotMessage): void;
  tryInitPredWorld(playerId: string): void;
}

function roomOf(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

function slotPose(room: SectorRoom, slot: number): Pose {
  const sab = (room as unknown as { sabF32: Float32Array }).sabF32;
  const b = slotBase(slot);
  return { x: sab[b + SLOT_X_OFF]!, y: sab[b + SLOT_Y_OFF]! };
}

/** The pilot's hull slot, active or parked. */
function hullSlot(room: SectorRoom, pid: string): number {
  const r = room as unknown as { playerToSlot: Map<string, number>; lingeringSlots: Map<string, number> };
  return r.playerToSlot.get(pid) ?? [...r.lingeringSlots.values()][0]!;
}

describe('spectate: the own parked hull is drawn where the server has it', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    useUIStore.setState({ pilotMode: 'pilot' });
    if (harness) await harness.cleanup();
    harness = undefined;
  });

  it('server: test_aggro then spectate never moves the parked cruiser off its spawn', { timeout: 40_000 }, async () => {
    harness = await bootSectorTestServer(structuredClone(SHOWCASE_CAPITAL_DUEL_OPTS) as never);
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { shipKind: 'heavy-cruiser', initialHull: 1_000_000, noselfdmg: 1, spawnX: 4000, spawnY: 0 });
    const room = roomOf(cr.roomId);
    const spawn = slotPose(room, hullSlot(room, pid));
    expect(Math.hypot(spawn.x - 4000, spawn.y), 'spawned at the room spawn').toBeLessThan(5);
    cr.send('test_aggro', { type: 'test_aggro' });
    await harness.advance(4000);
    cr.send('spectate', { type: 'spectate' });
    await harness.advance(4000);
    const r = room as unknown as { lingeringSlots: Map<string, number> };
    expect(r.lingeringSlots.size, 'hull parked').toBe(1);
    const parked = slotPose(room, hullSlot(room, pid));
    expect(Math.hypot(parked.x - spawn.x, parked.y - spawn.y), `parked hull drifted to (${parked.x.toFixed(1)}, ${parked.y.toFixed(1)})`).toBeLessThan(5);
  });

  it('client: after Spectate the own hull is not re-predicted at a pose-less schema seed', { timeout: 40_000 }, async () => {
    harness = await bootSectorTestServer(structuredClone(SHOWCASE_CAPITAL_DUEL_OPTS) as never);
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { shipKind: 'heavy-cruiser', initialHull: 1_000_000, noselfdmg: 1, spawnX: 4000, spawnY: 0 });
    const room = roomOf(cr.roomId);

    // The real client, bootstrapped the way the welcome + first snapshot do.
    useUIStore.setState({ pilotMode: 'pilot' });
    const client = new ColyseusGameClient();
    const c = client as unknown as ClientInternals;
    c.predWorld = await PhysicsWorld.create();
    c.room = cr;
    if (!c.mirror.lingeringShips) c.mirror.lingeringShips = new Map();
    const state = cr.state as unknown as SectorState;
    let instanceId = '';
    for (const [key, ship] of state.ships) if (ship.playerId === pid) instanceId = key;
    expect(instanceId, 'own schema entry').not.toBe('');
    c.mirror.localPlayerId = pid;
    c.mirror.localShipInstanceId = instanceId;
    const spawn = slotPose(room, hullSlot(room, pid));
    c.mirror.ships.set(pid, { x: spawn.x, y: spawn.y, vx: 0, vy: 0, angle: 0, kind: 'heavy-cruiser' });
    c.tryInitPredWorld(pid);
    expect(c.predWorld!.hasShip(pid), 'local body bootstrapped').toBe(true);

    // From here on the client is fed only the real wire: schema patches into
    // syncMirror, snapshots into the shared ship router (handleSnapshot's
    // first step).
    let lastSnap: SnapshotMessage | null = null;
    cr.onStateChange((s) => c.syncMirror(s));
    cr.onMessage('snapshot', (snap: SnapshotMessage) => { lastSnap = snap; c.handleSnapshot(snap); });

    // Spectate exactly as the spectator toggle does: pilotMode first, then send.
    useUIStore.setState({ pilotMode: 'spectator' });
    client.sendSpectate();
    const r = room as unknown as { lingeringSlots: Map<string, number> };
    for (let i = 0; i < 50 && r.lingeringSlots.size === 0; i++) await harness.advance(40);
    expect(r.lingeringSlots.size, 'hull parked').toBe(1);
    // Let the isActive=false patch and a few snapshots land.
    await harness.advance(1500);
    expect(lastSnap, 'snapshots flowing').not.toBeNull();

    const server = slotPose(room, hullSlot(room, pid));
    const drawn = c.mirror.ships.get(pid);
    const predicted = c.predWorld!.hasShip(pid);
    // The parked hull is not the pilot's ship any more: no predicted local body
    // and no own entry in `mirror.ships` (the parked hull is drawn from
    // `lingeringShips`, posed by snapshots).
    expect(
      { predicted, drawn: drawn ? { x: Math.round(drawn.x), y: Math.round(drawn.y) } : null },
      `server parked hull at (${server.x.toFixed(1)}, ${server.y.toFixed(1)}); the client must not draw a predicted own cruiser elsewhere`,
    ).toEqual({ predicted: false, drawn: null });
    // ...and the parked hull itself is drawn at the server's pose.
    const parked = [...c.mirror.lingeringShips!.values()].find((e) => e.ownerPlayerId === pid);
    expect(parked, 'own parked hull listed').toBeDefined();
    expect(Math.hypot(parked!.x - server.x, parked!.y - server.y), 'parked hull drawn at the server pose').toBeLessThan(50);
  });
});
