/**
 * A capital's shots are seen leaving its barrels by every viewer whose window
 * holds the hull, WHOEVER flies it (ship parity, player capitals stream).
 *
 * The wide-owner rule (`ownerWideInInterest`) looked owners up only in the
 * swarm registry, so a PLAYER-flown capital's shots more than 1.5 cells from a
 * viewer were dropped even though the viewer could see the hull firing. And a
 * viewer flying a capital (whose window grows with its hull) still got
 * projectiles only from the fixed 1.5-cell box around it.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Client, ClientArray } from 'colyseus';
import type { Logger } from 'pino';
import type { MapSchema } from '@colyseus/schema';
import { SnapshotBroadcaster, type SnapshotBroadcasterDeps } from './SnapshotBroadcaster.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { ShipState } from './schema/SectorState.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';
import type { ProjectileRecord } from './ProjectilePipeline.js';
import { CELL_SIZE, SpatialGrid } from '../interest/SpatialGrid.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

const VIEWER = 'viewer';
const VSID = `s-${VIEWER}`;
const SHOOTER = 'shooter';

interface Pilot { pid: string; kind: string; x: number; y: number; lingering?: boolean }

function ship(p: Pilot): ShipState {
  return {
    alive: true, isActive: !p.lingering, shipInstanceId: `inst-${p.pid}`, playerId: p.pid, kind: p.kind,
    level: 1, mounts: [], warp: 0, poseEpoch: 0, shield: 1,
  } as unknown as ShipState;
}

function proj(ownerId: string, x: number, y: number): ProjectileRecord {
  return { x, y, vx: 1, vy: 0, ownerId, birthTick: 99, damage: 1, radius: 1, maxTicks: 60, weaponId: 'laser' } as ProjectileRecord;
}

function setup(viewer: Pilot, shooter: Pilot, projectiles: Array<[string, ProjectileRecord]>): { b: SnapshotBroadcaster; sent: string[][] } {
  const pilots = [viewer, shooter];
  const ships = new Map(pilots.map((p) => [p.pid, ship(p)]));
  const poseOf = (p: Pilot): ShipPhysicsState => ({ x: p.x, y: p.y, vx: 0, vy: 0, angle: 0, angvel: 0 });
  const stubLogger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    fatal: () => {}, trace: () => {}, silent: () => {}, child: () => stubLogger,
  } as unknown as Logger;
  const sent: string[][] = [];
  const shipsMap = new Map<string, ShipState>();
  for (const p of pilots) shipsMap.set(`inst-${p.pid}`, ships.get(p.pid)!);
  const lingeringSlots = new Map<string, number>();
  const lingeringPoseCache = new Map<string, ShipPhysicsState>();
  const shipPoseCache = new Map<string, ShipPhysicsState>();
  for (const p of pilots) {
    if (p.lingering) { lingeringSlots.set(`inst-${p.pid}`, 1); lingeringPoseCache.set(`inst-${p.pid}`, poseOf(p)); }
    else shipPoseCache.set(p.pid, poseOf(p));
  }
  const deps = {
    serverTick: () => 100,
    sabU32: new Uint32Array(1024),
    clients: [{ sessionId: VSID, socket: { bufferedAmount: 0 }, send: vi.fn(), leave: vi.fn() }] as unknown as ClientArray<Client>,
    sessionToPlayer: new Map([[VSID, VIEWER]]),
    playerToSlot: new Map([[VIEWER, 0]]),
    getActiveShip: (pid: string) => { const s = ships.get(pid); return s && s.isActive ? s : undefined; },
    shipPoseCache,
    lingeringSlots,
    lingeringPoseCache,
    shipsMap: shipsMap as unknown as MapSchema<ShipState>,
    liveProjectiles: new Map(projectiles),
    boostingPlayers: new Set(),
    thrustingPlayers: new Set(),
    swarmRegistry: { get: () => undefined, getByEntityId: () => null, forEachRecord: () => {} },
    swarmHealth: new Map(),
    isDroneHostileTo: () => false,
    playerMountAngles: new Map(),
    droneMountAngles: new Map(),
    missileSim: { live: function* () { /* none */ } },
    logger: stubLogger,
    serverLogEvent: () => {},
    sendSnapshot: (_c: Client, snap: SnapshotMessage) => { sent.push((snap.projectiles ?? []).map((p) => p.id)); },
  } as unknown as SnapshotBroadcasterDeps;
  const b = new SnapshotBroadcaster(deps);
  // What the swarm broadcast records each tick: the viewer's window.
  const reach = SpatialGrid.viewerReachFor(getShipKind(viewer.kind).radius);
  b.interestWindows.note(VSID, Math.floor(viewer.x / CELL_SIZE), Math.floor(viewer.y / CELL_SIZE), reach);
  return { b, sent };
}

function lastProjectiles(b: SnapshotBroadcaster, sent: string[][]): string[] {
  for (let i = 0; i < 6; i++) b.broadcast(false);
  expect(sent.length).toBeGreaterThan(0);
  return sent[sent.length - 1]!;
}

describe('SnapshotBroadcaster — a player capital\'s shots reach viewers who can see it', () => {
  const far = CELL_SIZE * 2.2; // outside the 1.5-cell box, inside the 3x3 window

  it('a player battleship two cells away: its shot by the hull is sent', () => {
    const { b, sent } = setup(
      { pid: VIEWER, kind: 'fighter', x: 100, y: 100 },
      { pid: SHOOTER, kind: 'battleship', x: far, y: 100 },
      [['p1', proj(SHOOTER, far + 50, 100)]],
    );
    expect(lastProjectiles(b, sent)).toContain('p1');
  });

  it('an AI-flown player battleship (keyed by its hull id) is the same', () => {
    const { b, sent } = setup(
      { pid: VIEWER, kind: 'fighter', x: 100, y: 100 },
      { pid: SHOOTER, kind: 'battleship', x: far, y: 100, lingering: true },
      [['p1', proj(`inst-${SHOOTER}`, far + 50, 100)]],
    );
    expect(lastProjectiles(b, sent)).toContain('p1');
  });

  it('a player fighter at the same spot stays out of the box (unchanged)', () => {
    const { b, sent } = setup(
      { pid: VIEWER, kind: 'fighter', x: 100, y: 100 },
      { pid: SHOOTER, kind: 'fighter', x: far, y: 100 },
      [['p1', proj(SHOOTER, far + 50, 100)]],
    );
    expect(lastProjectiles(b, sent)).not.toContain('p1');
  });

  it('a viewer flying a battleship sees small shots across its grown window', () => {
    const reach = SpatialGrid.viewerReachFor(getShipKind('battleship').radius);
    expect(reach, 'a battleship window is wider than 3x3').toBeGreaterThan(1);
    const x = CELL_SIZE * (reach + 0.2);
    const { b, sent } = setup(
      { pid: VIEWER, kind: 'battleship', x: 100, y: 100 },
      { pid: SHOOTER, kind: 'fighter', x, y: 100 },
      [['p1', proj(SHOOTER, x, 100)]],
    );
    expect(lastProjectiles(b, sent)).toContain('p1');
  });
});
