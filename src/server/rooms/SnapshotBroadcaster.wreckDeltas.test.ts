/**
 * Sub-capital break-up slice 3 — wreck descriptors on the wire at volume.
 *
 * Before: every snapshot for a few broadcasts after ANY change, and at 2 Hz
 * otherwise, carried the WHOLE `wrecks[]` list (~170 B per live wreck). With
 * sub-capitals leaving permanent wrecks at ~200 deaths a minute that list is
 * resent almost every snapshot and grows with every wreck.
 *
 * Now: the full set rides the welcome; a snapshot carries only the ADDS and
 * REMOVES of its short window, plus a slow rolling resync of a few
 * descriptors. These tests drive the real `SnapshotBroadcaster` against a
 * fake wreck source and lock:
 *   - one new death among N live wrecks rides as 1 add, not N;
 *   - wreck bytes per second stay flat as the live set grows;
 *   - a remove rides as its id only;
 *   - the resync is a bounded chunk that walks the whole id space.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Client, ClientArray } from 'colyseus';
import type { Logger } from 'pino';
import type { MapSchema } from '@colyseus/schema';
import { Packr } from '@colyseus/msgpackr';
import { SnapshotBroadcaster, type SnapshotBroadcasterDeps } from './SnapshotBroadcaster.js';
import { WRECK_DELTA_WINDOW, WRECK_RESYNC_CHUNK, WRECK_RESYNC_EVERY, WRECK_ID_END } from './WreckWireDeltas.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { ShipState } from './schema/SectorState.js';
import type { SnapshotMessage, WreckDescriptor } from '../../shared-types/messages.js';

const PID = 'pilot-a';
const SID = `s-${PID}`;

function makeWreck(id: number): WreckDescriptor {
  return {
    wreckId: id, parentKind: 'battleship', seed: 1000 + id, killX: 12.5, killY: -40.25,
    killBlowDamage: 0.31, recentDamageRate: 0.82, snapChance: 0.15, algoVersion: 6, deathTick: 5000 + id,
  };
}

/** A stand-in for `CapitalWreckSubsystem`: a live list + a version. */
class FakeWrecks {
  readonly list: WreckDescriptor[] = [];
  version = 0;
  add(d: WreckDescriptor): void { this.list.push(d); this.version++; }
  remove(id: number): void {
    const i = this.list.findIndex((d) => d.wreckId === id);
    if (i >= 0) { this.list.splice(i, 1); this.version++; }
  }
}

type WreckFields = Pick<SnapshotMessage, 'wreckAdds' | 'wreckRemoves' | 'wreckSync'>;

function setup(wrecks: FakeWrecks): { b: SnapshotBroadcaster; snaps: WreckFields[] } {
  const ship = {
    alive: true, isActive: true, shipInstanceId: `inst-${PID}`, playerId: PID, kind: 'fighter',
    level: 1, mounts: [], warp: 0, poseEpoch: 0, shield: 1,
  } as unknown as ShipState;
  const stubLogger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    fatal: () => {}, trace: () => {}, silent: () => {}, child: () => stubLogger,
  } as unknown as Logger;
  const snaps: WreckFields[] = [];
  const deps = {
    serverTick: () => 100,
    sabU32: new Uint32Array(1024),
    clients: [{ sessionId: SID, socket: { bufferedAmount: 0 }, send: vi.fn(), leave: vi.fn() }] as unknown as ClientArray<Client>,
    sessionToPlayer: new Map([[SID, PID]]),
    playerToSlot: new Map([[PID, 0]]),
    getActiveShip: () => ship,
    shipPoseCache: new Map<string, ShipPhysicsState>([[PID, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 }]]),
    lingeringSlots: new Map(),
    lingeringPoseCache: new Map(),
    shipsMap: new Map([[PID, ship]]) as unknown as MapSchema<ShipState>,
    liveProjectiles: new Map(),
    boostingPlayers: new Set(),
    thrustingPlayers: new Set(),
    swarmRegistry: { getByEntityId: () => null },
    swarmHealth: new Map(),
    isDroneHostileTo: () => false,
    playerMountAngles: new Map(),
    droneMountAngles: new Map(),
    missileSim: { live: function* () { /* none */ } },
    logger: stubLogger,
    serverLogEvent: () => {},
    getWrecks: () => wrecks.list,
    wrecksVersion: () => wrecks.version,
    sendSnapshot: (_c: Client, snap: SnapshotMessage) => {
      // Deep copy: the broadcaster reuses its arrays (#14).
      snaps.push(JSON.parse(JSON.stringify({
        wreckAdds: snap.wreckAdds, wreckRemoves: snap.wreckRemoves, wreckSync: snap.wreckSync,
      })) as WreckFields);
    },
  } as unknown as SnapshotBroadcasterDeps;
  return { b: new SnapshotBroadcaster(deps), snaps };
}

const packr = new Packr({ encodeUndefinedAsNil: false });
function wreckBytes(s: WreckFields): number {
  if (s.wreckAdds === undefined && s.wreckRemoves === undefined && s.wreckSync === undefined) return 0;
  return packr.pack(s).length;
}

/** Wreck bytes per second at one recipient over `seconds` of broadcasts
 *  (60 counters a second) with `deathsPerSec` new wrecks arriving. */
function bytesPerSecond(liveAtStart: number, deathsPerSec: number, seconds: number): number {
  const w = new FakeWrecks();
  let next = 1;
  for (let i = 0; i < liveAtStart; i++) w.add(makeWreck(next++));
  const { b, snaps } = setup(w);
  // Settle: let the start-up adds age out of their window.
  for (let i = 0; i < WRECK_DELTA_WINDOW * 2; i++) b.broadcast(false);
  snaps.length = 0;
  const every = Math.round(60 / deathsPerSec);
  for (let c = 0; c < seconds * 60; c++) {
    if (c % every === 0) w.add(makeWreck(next++));
    b.broadcast(false);
  }
  return snaps.reduce((n, s) => n + wreckBytes(s), 0) / seconds;
}

describe('SnapshotBroadcaster — wreck descriptor deltas', () => {
  it('with N live wrecks, one new death rides as 1 add (not N), for its window only', () => {
    const w = new FakeWrecks();
    for (let id = 1; id <= 50; id++) w.add(makeWreck(id));
    const { b, snaps } = setup(w);
    for (let i = 0; i < WRECK_DELTA_WINDOW * 2; i++) b.broadcast(false);
    snaps.length = 0;

    w.add(makeWreck(51));
    for (let i = 0; i < WRECK_DELTA_WINDOW * 2; i++) b.broadcast(false);

    const withAdd = snaps.filter((s) => s.wreckAdds !== undefined);
    expect(withAdd.length, 'the add repeats on a few snapshots, so one drop never loses it').toBeGreaterThanOrEqual(3);
    for (const s of withAdd) {
      expect(s.wreckAdds!.map((d) => d.wreckId)).toEqual([51]);
    }
    // Then it's gone: the last snapshots carry no adds.
    expect(snaps[snaps.length - 1]!.wreckAdds).toBeUndefined();
    // No snapshot ever carries the whole live set.
    for (const s of snaps) {
      const n = (s.wreckAdds?.length ?? 0) + (s.wreckSync?.d.length ?? 0);
      expect(n).toBeLessThanOrEqual(1 + WRECK_RESYNC_CHUNK);
    }
  });

  it('a gone wreck rides as its id in wreckRemoves', () => {
    const w = new FakeWrecks();
    for (let id = 1; id <= 5; id++) w.add(makeWreck(id));
    const { b, snaps } = setup(w);
    for (let i = 0; i < WRECK_DELTA_WINDOW * 2; i++) b.broadcast(false);
    snaps.length = 0;
    w.remove(3);
    for (let i = 0; i < WRECK_DELTA_WINDOW * 2; i++) b.broadcast(false);
    const withRemove = snaps.filter((s) => s.wreckRemoves !== undefined);
    expect(withRemove.length).toBeGreaterThanOrEqual(3);
    for (const s of withRemove) expect(s.wreckRemoves).toEqual([3]);
    expect(snaps.some((s) => s.wreckAdds !== undefined)).toBe(false);
  });

  it('a recycled id never rides as both a remove and an add', () => {
    const w = new FakeWrecks();
    w.add(makeWreck(7));
    const { b, snaps } = setup(w);
    for (let i = 0; i < WRECK_DELTA_WINDOW * 2; i++) b.broadcast(false);
    snaps.length = 0;
    w.remove(7);
    b.broadcast(false);
    const reborn = { ...makeWreck(7), seed: 99 };
    w.add(reborn);
    for (let i = 0; i < WRECK_DELTA_WINDOW; i++) b.broadcast(false);
    for (const s of snaps.slice(-3)) {
      expect(s.wreckRemoves ?? []).not.toContain(7);
      expect(s.wreckAdds?.find((d) => d.wreckId === 7)?.seed).toBe(99);
    }
  });

  it('wreck bytes per second stay flat as wrecks accumulate', () => {
    const at10 = bytesPerSecond(10, 3, 10);
    const at300 = bytesPerSecond(300, 3, 10);
    const at1000 = bytesPerSecond(1000, 3, 10);
    // eslint-disable-next-line no-console -- the measurement the PR body cites
    console.log(`wreck bytes/s at one recipient, 3 deaths/s: 10 live ${at10.toFixed(0)}, 300 live ${at300.toFixed(0)}, 1000 live ${at1000.toFixed(0)}`);
    expect(at300).toBeLessThan(at10 * 1.25);
    expect(at1000).toBeLessThan(at10 * 1.25);
    // And small in absolute terms: well under the old full-list resend.
    expect(at1000).toBeLessThan(8_000);
  });

  it('the resync is a bounded chunk that walks the whole id space', () => {
    const w = new FakeWrecks();
    for (let id = 1; id <= 40; id++) w.add(makeWreck(id * 3));
    const { b, snaps } = setup(w);
    const covered = new Set<number>();
    let wrapped = false;
    for (let c = 0; c < WRECK_RESYNC_EVERY * 12; c++) {
      b.broadcast(false);
      const s = snaps[snaps.length - 1];
      if (s?.wreckSync === undefined) continue;
      expect(s.wreckSync.d.length).toBeLessThanOrEqual(WRECK_RESYNC_CHUNK);
      for (const d of s.wreckSync.d) {
        expect(d.wreckId).toBeGreaterThanOrEqual(s.wreckSync.lo);
        expect(d.wreckId).toBeLessThan(s.wreckSync.hi);
        covered.add(d.wreckId);
      }
      if (s.wreckSync.hi === WRECK_ID_END) wrapped = true;
    }
    expect(covered.size, 'every live wreck is resent within a few cycles').toBe(40);
    expect(wrapped).toBe(true);
  });
});
