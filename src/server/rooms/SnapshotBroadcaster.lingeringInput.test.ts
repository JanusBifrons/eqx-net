/**
 * RTS slice 4c — a lingering hull's `lastInput` comes from its slot FLAGS
 * word (the worker mirrors the wingman's last-applied INPUT bits there), so
 * observers can forward-predict the hull and draw its thrust flame.
 *
 * Also locks the dedupe key: the idle-bits cache is per HULL. A player's
 * active ship and their lingering hull share one playerId; keyed by playerId,
 * the two entries looked "changed" against each other on every snapshot and
 * both re-sent `lastInput` forever.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Client, ClientArray } from 'colyseus';
import type { Logger } from 'pino';
import type { MapSchema } from '@colyseus/schema';
import { SnapshotBroadcaster, type SnapshotBroadcasterDeps } from './SnapshotBroadcaster.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { ShipState } from './schema/SectorState.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';
import {
  FLAG_INPUT_THRUST,
  FLAG_INPUT_TURN_LEFT,
  SLOT_FLAGS_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';

const PID = 'p0';
const HULL = 'hull-A';
const HULL_SLOT = 5;

function setup(): { broadcaster: SnapshotBroadcaster; sent: SnapshotMessage[]; sabU32: Uint32Array } {
  const sabU32 = new Uint32Array(1024);
  const sent: SnapshotMessage[] = [];
  const pose = (x: number): ShipPhysicsState => ({ x, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 });
  const active = { alive: true, isActive: true, shipInstanceId: 'inst-p0', playerId: PID, shield: 1, level: 1 } as unknown as ShipState;
  const parked = { alive: true, isActive: false, shipInstanceId: HULL, playerId: PID, shield: 1, level: 1 } as unknown as ShipState;
  const ships = new Map<string, ShipState>([[PID, active], [HULL, parked]]);
  const client = {
    sessionId: 's0',
    socket: { bufferedAmount: 0 },
    // The broadcaster pools state entries: copy what was sent.
    send: vi.fn((_t: string, snap: SnapshotMessage) => { sent.push(JSON.parse(JSON.stringify(snap)) as SnapshotMessage); }),
    leave: vi.fn(),
  };
  const stubLogger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    fatal: () => {}, trace: () => {}, silent: () => {},
    child: () => stubLogger,
  } as unknown as Logger;
  const deps: SnapshotBroadcasterDeps = {
    serverTick: () => 100,
    sabU32,
    clients: [client] as unknown as ClientArray<Client>,
    sessionToPlayer: new Map([['s0', PID]]),
    playerToSlot: new Map([[PID, 0]]),
    getActiveShip: (pid: string) => (pid === PID ? active : undefined),
    shipPoseCache: new Map([[PID, pose(0)]]),
    lingeringSlots: new Map([[HULL, HULL_SLOT]]),
    lingeringPoseCache: new Map([[HULL, pose(100)]]),
    shipsMap: ships as unknown as MapSchema<ShipState>,
    liveProjectiles: new Map() as unknown as SnapshotBroadcasterDeps['liveProjectiles'],
    boostingPlayers: new Set(),
    thrustingPlayers: new Set(),
    swarmRegistry: { getByEntityId: () => null },
    playerMountAngles: new Map(),
    droneMountAngles: new Map(),
    missileSim: { live: function* () { /* empty */ } },
    logger: stubLogger,
    serverLogEvent: () => {},
  };
  return { broadcaster: new SnapshotBroadcaster(deps), sent, sabU32 };
}

function runUntil(b: SnapshotBroadcaster, sent: SnapshotMessage[], n: number): void {
  for (let i = 0; i < 300 && sent.length < n; i++) b.broadcast(false);
}

describe('SnapshotBroadcaster — lingering hull input bits (RTS slice 4c)', () => {
  it('publishes the hull slot flags as the lingering entry lastInput', () => {
    const { broadcaster, sent, sabU32 } = setup();
    sabU32[slotBase(HULL_SLOT) + SLOT_FLAGS_OFF] = FLAG_INPUT_THRUST | FLAG_INPUT_TURN_LEFT;
    runUntil(broadcaster, sent, 1);
    const hull = sent[0]!.states[HULL]!;
    expect(hull.isActive).toBe(false);
    expect(hull.lastInput).toEqual({ thrust: true, turnLeft: true, turnRight: false, boost: false, reverse: false });
    // The pilot's active ship reads its own slot (no bits held).
    expect(sent[0]!.states['inst-p0']!.lastInput?.thrust).toBe(false);
  });

  it('dedupes per hull: unchanged bits are omitted for both the active ship and the parked hull', () => {
    const { broadcaster, sent, sabU32 } = setup();
    sabU32[slotBase(HULL_SLOT) + SLOT_FLAGS_OFF] = FLAG_INPUT_THRUST;
    runUntil(broadcaster, sent, 3);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(sent[1]!.states[HULL]!.lastInput).toBeUndefined();
    expect(sent[1]!.states['inst-p0']!.lastInput).toBeUndefined();
    // A change is sent again.
    sabU32[slotBase(HULL_SLOT) + SLOT_FLAGS_OFF] = 0;
    const before = sent.length;
    runUntil(broadcaster, sent, before + 1);
    expect(sent[before]!.states[HULL]!.lastInput?.thrust).toBe(false);
  });
});
