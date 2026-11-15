/**
 * Emit-when-non-default means ABSENT, not `undefined` (2026-11-14 trim).
 *
 * Both snapshot encoders (Colyseus's msgpackr on the WebSocket, the WebRTC
 * `Packr`) write an own property whose value is `undefined` as the key name
 * plus a 3-byte ext. The broadcaster used to clear pooled fields with
 * `= undefined` (written for notepack.io, which skipped them), so every
 * snapshot carried ~30 empty keys: ~8 of capital-fleet's 13 KB/s of snapshot
 * JSON. `setOrDrop` removes the key instead.
 *
 * #15: the client side of the contract is "a missing key reads as empty or
 * default"; the last test runs a decoded snapshot through the client's own
 * readers (wreck-delta carry, time-scale default).
 */

import { describe, expect, it, vi } from 'vitest';
import { Packr } from '@colyseus/msgpackr';
import type { Client, ClientArray } from 'colyseus';
import type { Logger } from 'pino';
import type { MapSchema } from '@colyseus/schema';
import { SnapshotBroadcaster, setOrDrop, type SnapshotBroadcasterDeps, type SwarmDroneRec } from '../../src/server/rooms/SnapshotBroadcaster.js';
import type { ShipPhysicsState } from '../../src/core/physics/World.js';
import type { ShipState } from '../../src/server/rooms/schema/SectorState.js';
import type { SnapshotMessage, WreckDescriptor } from '../../src/shared-types/messages.js';
import { carryWreckDeltas } from '../../src/client/net/SnapshotCoalescer.js';
import { LOCKED_BY_WIRE_ROWS } from '../../src/shared-types/combat/lockProfile.js';

const PID = 'pilot-a';
const SID = `s-${PID}`;

/** The two encoders a snapshot goes through (Colyseus core's WS packr and
 *  `webrtcChannel.ts`'s), configured as they are in production. */
const ENCODERS = {
  ws: new Packr({ useRecords: false }),
  webrtc: new Packr({ encodeUndefinedAsNil: false }),
};

interface Drone extends SwarmDroneRec { entityId: number }

interface World {
  boosting: Set<string>;
  hostile: Set<string>;
  level: number;
  timeScale: SnapshotMessage['timeScale'];
  mountAngles: SnapshotMessage['structureMountAngles'];
  playerAngles: Float32Array;
  /** NPC lock rows on the pilot + the total of every locker. */
  lockRows?: Array<{ t: string; s: 1 | 2; p: number }>;
  lockTotal?: number;
  lockLocked?: number;
}

function setup(world: World): { b: SnapshotBroadcaster; sent: SnapshotMessage[] } {
  const drones: Drone[] = [{ id: 'd-far', kind: 1, entityId: 11, shipKind: 'fighter' }];
  const ship = {
    alive: true, isActive: true, shipInstanceId: `inst-${PID}`, playerId: PID, kind: 'fighter',
    get level() { return world.level; }, mounts: [], warp: 0, poseEpoch: 0, shield: 1, energy: 50,
  } as unknown as ShipState;
  const stubLogger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    fatal: () => {}, trace: () => {}, silent: () => {}, child: () => stubLogger,
  } as unknown as Logger;
  const sent: SnapshotMessage[] = [];
  const deps = {
    serverTick: () => 100,
    sabU32: new Uint32Array(1024),
    clients: [{ sessionId: SID, socket: { bufferedAmount: 0 }, send: vi.fn(), leave: vi.fn() }] as unknown as ClientArray<Client>,
    sessionToPlayer: new Map([[SID, PID]]),
    playerToSlot: new Map([[PID, 0]]),
    getActiveShip: () => ship,
    shipPoseCache: new Map<string, ShipPhysicsState>([[PID, { x: 1.5, y: 2.5, vx: 0, vy: 0, angle: 0, angvel: 0 }]]),
    lingeringSlots: new Map(),
    lingeringPoseCache: new Map(),
    shipsMap: new Map([[PID, ship]]) as unknown as MapSchema<ShipState>,
    liveProjectiles: new Map(),
    boostingPlayers: world.boosting,
    thrustingPlayers: new Set(),
    swarmRegistry: {
      getByEntityId: (eid: number) => drones.find((d) => d.entityId === eid) ?? null,
      forEachRecord: (visit: (rec: Drone) => void) => { for (const d of drones) visit(d); },
    },
    swarmHealth: new Map(),
    isDroneHostileTo: (id: string) => world.hostile.has(id),
    playerMountAngles: new Map([[PID, world.playerAngles]]),
    droneMountAngles: new Map(),
    missileSim: { live: function* () { /* none */ } },
    logger: stubLogger,
    serverLogEvent: () => {},
    getStructureMountAngles: () => world.mountAngles,
    getWrecks: () => [],
    wrecksVersion: () => 0,
    timeScale: () => world.timeScale,
    lockedByOf: () => world.lockRows,
    lockedByTotalOf: () => world.lockTotal ?? world.lockRows?.length ?? 0,
    lockedByLockedOf: () => world.lockLocked ?? 0,
    // Encode synchronously, like both production paths.
    sendSnapshot: (_c: Client, snap: SnapshotMessage) => {
      sent.push(ENCODERS.ws.unpack(ENCODERS.ws.pack(snap)) as SnapshotMessage);
    },
  } as unknown as SnapshotBroadcasterDeps;
  return { b: new SnapshotBroadcaster(deps), sent };
}

/** Every own key whose value is `undefined`, anywhere in the decoded tree. */
function undefinedKeys(v: unknown, path = 'snap', out: string[] = []): string[] {
  if (v === null || typeof v !== 'object') return out;
  for (const [k, child] of Object.entries(v)) {
    if (child === undefined) out.push(`${path}.${k}`);
    else undefinedKeys(child, `${path}.${k}`, out);
  }
  return out;
}

/** Run broadcasts until the far-drone tier has fired (it rides one counter
 *  window in 30), and return the last snapshot sent. */
function broadcastUntilFar(b: SnapshotBroadcaster, sent: SnapshotMessage[]): SnapshotMessage {
  for (let i = 0; i < 60; i++) b.broadcast(false);
  return sent.find((s) => s.drones !== undefined) ?? sent[sent.length - 1]!;
}

describe('setOrDrop', () => {
  it('assigns a value, and removes the key (not sets undefined) when absent', () => {
    const o: { a?: number; b?: string } = {};
    setOrDrop(o, 'a', 3);
    expect(o).toEqual({ a: 3 });
    setOrDrop(o, 'a', undefined);
    expect('a' in o).toBe(false);
    setOrDrop(o, 'b', undefined);
    expect(Object.keys(o)).toEqual([]);
  });

  it('both production encoders DO write an undefined property (the reason it exists)', () => {
    for (const p of Object.values(ENCODERS)) {
      expect(p.pack({ a: 1, structureMountAngles: undefined }).byteLength)
        .toBeGreaterThan(p.pack({ a: 1 }).byteLength + 20);
    }
  });
});

describe('SnapshotBroadcaster — default fields are absent on the wire', () => {
  it('a quiet snapshot carries no undefined keys, and stays small', () => {
    const world: World = {
      boosting: new Set(), hostile: new Set(), level: 1, timeScale: undefined, mountAngles: undefined,
      playerAngles: new Float32Array(2),
    };
    const { b, sent } = setup(world);
    for (let i = 0; i < 6; i++) b.broadcast(false);
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) {
      expect(undefinedKeys(s)).toEqual([]);
      for (const k of ['boostingIds', 'thrustingIds', 'projectiles', 'missiles', 'drones', 'asteroids',
        'structureTargets', 'structureMountAngles', 'shellKey', 'wreckAdds', 'wreckRemoves', 'timeScale',
        'wsBufferedAmountBytes'] as const) {
        expect(k in s, `${k} absent when empty`).toBe(false);
      }
    }
    // The first snapshot seeds the lastInput dedupe cache; later ones don't.
    const last = sent[sent.length - 1]!;
    const st = last.states[`inst-${PID}`]!;
    for (const k of ['lastInput', 'mountAngles', 'shieldDown', 'level', 'statAlloc', 'cargo', 'depositing',
      'groups', 'lockedBy', 'lockedByN', 'lockedByL', 'fitted', 'wallet', 'poseEpoch', 'warp', 'disabledMs', 'mounts'] as const) {
      expect(k in st, `states[].${k} absent when default`).toBe(false);
    }
    // One pilot, nothing happening: under 200 B per snapshot on both
    // encoders (the quiet snapshot was ~500 B with the undefined keys).
    for (const p of Object.values(ENCODERS)) expect(p.pack(last).byteLength).toBeLessThan(200);
  });

  it('a field that goes back to default leaves the pooled entry (no stale value, no undefined key)', () => {
    const world: World = {
      boosting: new Set([PID]), hostile: new Set(['d-far']), level: 3,
      timeScale: { s: 0.5, fromTick: 90 } as SnapshotMessage['timeScale'],
      mountAngles: [11, 0.5], playerAngles: new Float32Array([0.25, 0]),
    };
    const { b, sent } = setup(world);
    const busy = broadcastUntilFar(b, sent);
    expect(busy.boostingIds).toEqual([PID]);
    expect(busy.timeScale?.s).toBe(0.5);
    expect(busy.structureMountAngles).toEqual([11, 0.5]);
    expect(busy.states[`inst-${PID}`]!.level).toBe(3);
    expect(busy.states[`inst-${PID}`]!.mountAngles).toEqual([0.25, 0]);
    const far = busy.drones!.find((d) => d.id === 11)!;
    expect(far.hostile).toBe(true);
    expect('mountAngles' in far, 'a far drone carries no angle key').toBe(false);

    world.boosting.clear(); world.hostile.clear(); world.level = 1;
    world.timeScale = undefined; world.mountAngles = undefined; world.playerAngles.fill(0);
    sent.length = 0;
    for (let i = 0; i < 60; i++) b.broadcast(false);
    for (const s of sent) {
      expect(undefinedKeys(s)).toEqual([]);
      expect('boostingIds' in s || 'timeScale' in s || 'structureMountAngles' in s || 'drones' in s).toBe(false);
      const st = s.states[`inst-${PID}`]!;
      expect('level' in st || 'mountAngles' in st).toBe(false);
    }
  });

  it('lockedBy rows + lockedByN: the total rides only when the rows are capped (owner 2026-11-14)', () => {
    const rows = Array.from({ length: LOCKED_BY_WIRE_ROWS }, (_, i) => ({ t: `s:${i + 1}`, s: 2 as const, p: 100 }));
    const world: World = {
      boosting: new Set(), hostile: new Set(), level: 1, timeScale: undefined, mountAngles: undefined,
      playerAngles: new Float32Array(1), lockRows: rows, lockTotal: 20,
    };
    const { b, sent } = setup(world);
    for (let i = 0; i < 3; i++) b.broadcast(false);
    let st = sent[sent.length - 1]!.states[`inst-${PID}`]!;
    expect(st.lockedBy).toHaveLength(LOCKED_BY_WIRE_ROWS);
    expect(st.lockedByN).toBe(20);
    // Every row locked and no completed lock off the list: no locked count.
    expect('lockedByL' in st).toBe(false);
    // 14 completed locks, 6 of them off the rows: the exact count rides.
    world.lockLocked = 14;
    for (let i = 0; i < 3; i++) b.broadcast(false);
    st = sent[sent.length - 1]!.states[`inst-${PID}`]!;
    expect(st.lockedByL).toBe(14);
    // Every locker on the list ⇒ no total key (the client reads the rows' count).
    world.lockTotal = LOCKED_BY_WIRE_ROWS;
    for (let i = 0; i < 3; i++) b.broadcast(false);
    st = sent[sent.length - 1]!.states[`inst-${PID}`]!;
    expect('lockedByN' in st).toBe(false);
    expect('lockedByL' in st).toBe(false);
    expect(undefinedKeys(sent[sent.length - 1])).toEqual([]);
  });

  it('client side (#15): a decoded snapshot with the keys absent reads as empty / default', () => {
    const world: World = {
      boosting: new Set(), hostile: new Set(), level: 1, timeScale: undefined, mountAngles: undefined,
      playerAngles: new Float32Array(1),
    };
    const { b, sent } = setup(world);
    b.broadcast(false); b.broadcast(false); b.broadcast(false);
    const newer = sent[sent.length - 1]!;
    expect('wreckAdds' in newer).toBe(false);
    // The client's time-scale read: absent ⇒ 1×.
    expect(newer.timeScale?.s ?? 1).toBe(1);
    // The coalescer's wreck carry folds an older delta into a newer snapshot
    // whose delta keys are absent ("absent = no change").
    const add = { wreckId: 7 } as unknown as WreckDescriptor;
    const older = { ...newer, wreckAdds: [add], wreckRemoves: [9] } as SnapshotMessage;
    carryWreckDeltas(older, newer);
    expect(newer.wreckAdds).toEqual([add]);
    expect(newer.wreckRemoves).toEqual([9]);
    expect(newer.wreckSync).toBeUndefined();
  });
});
