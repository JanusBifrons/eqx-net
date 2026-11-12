/**
 * Naval shells and the snapshot (real-scale ranges slice 7, shells as events
 * slice 4). Naval shells travel only as `shell_salvo` / `shell_end` /
 * keyframes (ShellEventHub, docs/architecture/shell-events.md), so no
 * `naval_*` shell ever rides `projectiles[]`, wherever it is. The hub sizes
 * its viewer rule with `shellViewHalfExtent` (the widest camera view for the
 * hull a viewer flies, #15 with the client zoom floor), locked here too.
 * Sub-capital projectiles keep the ±3,072 u box.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Client, ClientArray } from 'colyseus';
import type { Logger } from 'pino';
import type { MapSchema } from '@colyseus/schema';
import { Packr } from '@colyseus/msgpackr';
import { SnapshotBroadcaster, type SnapshotBroadcasterDeps } from './SnapshotBroadcaster.js';
import type { ProjectileRecord } from './ProjectilePipeline.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { ShipState } from './schema/SectorState.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';
import type { WeaponId } from '../../core/combat/WeaponCatalogue.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { GAMEPLAY_MIN_ZOOM, SHELL_VIEW_HALF_PX, shellViewHalfExtent, zoomRangeForKind } from '../../shared-types/shipScale/tuning.js';

const TICK = 100;
/** A real-scale 16" round: 1,290 u/s. The flight is cut so it falls ~25 km
 *  east of the firing battleship, beside viewer `east`. */
const SHELL_SPEED = 1290;
const FLIGHT_TICKS = Math.round((25_000 / SHELL_SPEED) * 60);

interface Viewer { pid: string; kind: string; x: number; y: number }

function makeDeps(viewers: Viewer[], projectiles: Map<string, ProjectileRecord>): {
  deps: SnapshotBroadcasterDeps;
  firstSnaps: Map<string, SnapshotMessage>;
  bytes: Map<string, number>;
} {
  const playerToSlot = new Map<string, number>();
  const shipPoseCache = new Map<string, ShipPhysicsState>();
  const ships = new Map<string, ShipState>();
  const sessionToPlayer = new Map<string, string>();
  const clients: Array<{ sessionId: string; socket: { bufferedAmount: number }; send: ReturnType<typeof vi.fn>; leave: ReturnType<typeof vi.fn> }> = [];
  viewers.forEach((v, i) => {
    playerToSlot.set(v.pid, i);
    sessionToPlayer.set(`s-${v.pid}`, v.pid);
    shipPoseCache.set(v.pid, { x: v.x, y: v.y, vx: 0, vy: 0, angle: 0, angvel: 0 });
    ships.set(v.pid, {
      alive: true, isActive: true, shipInstanceId: `inst-${v.pid}`, playerId: v.pid, kind: v.kind,
      level: 1, mounts: [], warp: 0, poseEpoch: 0, shield: 1,
    } as unknown as ShipState);
    clients.push({ sessionId: `s-${v.pid}`, socket: { bufferedAmount: 0 }, send: vi.fn(), leave: vi.fn() });
  });
  const stubLogger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    fatal: () => {}, trace: () => {}, silent: () => {}, child: () => stubLogger,
  } as unknown as Logger;
  const firstSnaps = new Map<string, SnapshotMessage>();
  const bytes = new Map<string, number>();
  const packr = new Packr({ encodeUndefinedAsNil: false });
  const deps: SnapshotBroadcasterDeps = {
    serverTick: () => TICK,
    sabU32: new Uint32Array(1024),
    clients: clients as unknown as ClientArray<Client>,
    sessionToPlayer,
    playerToSlot,
    getActiveShip: (pid: string) => ships.get(pid),
    shipPoseCache,
    lingeringSlots: new Map(),
    lingeringPoseCache: new Map(),
    shipsMap: ships as unknown as MapSchema<ShipState>,
    liveProjectiles: projectiles,
    boostingPlayers: new Set(),
    thrustingPlayers: new Set(),
    // The firing battleship is a swarm capital, NOT in any viewer's interest
    // (it is 25 km+ away), so the old wide-owner exception never applies.
    swarmRegistry: {
      getByEntityId: () => null,
      get: (id: string) => (id === 'drone-bb' ? { entityId: 7, radius: 2876, kind: 1 } : null),
    },
    swarmHealth: new Map(),
    isDroneHostileTo: () => false,
    playerMountAngles: new Map(),
    droneMountAngles: new Map(),
    missileSim: { live: function* () { /* none */ } },
    logger: stubLogger,
    serverLogEvent: () => {},
    sendSnapshot: (client: Client, snap: SnapshotMessage) => {
      if (firstSnaps.has(client.sessionId)) return;
      // The projectile array is a reused scratch: copy it at send time.
      firstSnaps.set(client.sessionId, { ...snap, projectiles: snap.projectiles?.map((p) => ({ ...p })) });
      bytes.set(client.sessionId, packr.pack(snap).length);
    },
  } as unknown as SnapshotBroadcasterDeps;
  return { deps, firstSnaps, bytes };
}

function shell(id: WeaponId, x: number, y: number, vx: number, vy: number, maxTicks: number): ProjectileRecord {
  return { x, y, vx, vy, ownerId: 'drone-bb', birthTick: TICK, damage: 1400, radius: 6, maxTicks, weaponId: id };
}

function firstSnapIds(viewers: Viewer[], projectiles: Map<string, ProjectileRecord>): Map<string, string[]> {
  const { deps, firstSnaps } = makeDeps(viewers, projectiles);
  const b = new SnapshotBroadcaster(deps);
  for (let i = 0; i < 60 && firstSnaps.size < viewers.length; i++) b.broadcast(false);
  const out = new Map<string, string[]>();
  for (const v of viewers) {
    const snap = firstSnaps.get(`s-${v.pid}`);
    expect(snap, `viewer ${v.pid} got a snapshot`).toBeDefined();
    out.set(v.pid, (snap!.projectiles ?? []).map((p) => p.id));
  }
  return out;
}

describe('shellViewHalfExtent — the widest view per hull (#15: the client camera floor)', () => {
  it('covers the 1920-px reference view at the zoom-out floor zoomRangeForKind gives the client', () => {
    for (const id of ['fighter', 'scout', 'destroyer', 'battleship']) {
      const kind = getShipKind(id);
      const { minScale } = zoomRangeForKind(kind, 1, { minScale: 0, startZoom: 0 });
      expect(shellViewHalfExtent(kind)).toBeGreaterThanOrEqual(SHELL_VIEW_HALF_PX / minScale - 1e-6);
    }
    // A sub-capital: half of a 1920-px view at the ordinary floor.
    expect(shellViewHalfExtent({ radius: 100 })).toBeCloseTo(SHELL_VIEW_HALF_PX / GAMEPLAY_MIN_ZOOM, 6);
    expect(shellViewHalfExtent({ radius: 2876 })).toBeGreaterThan(30_000);
  });
});

describe('SnapshotBroadcaster — naval shells never ride projectiles[] (slice 4)', () => {
  const east: Viewer = { pid: 'east', kind: 'fighter', x: 25_000, y: 0 };

  it('no calibre is sent, near or far; a bolt in the box still is', () => {
    const projectiles = new Map<string, ProjectileRecord>();
    const calibres: WeaponId[] = ['naval_s', 'naval_m', 'naval_l', 'naval_xl', 'naval_xxl', 'naval_siege'];
    calibres.forEach((w, i) => {
      projectiles.set(`far-${i}`, shell(w, 0, 0, SHELL_SPEED, 0, FLIGHT_TICKS));
      projectiles.set(`near-${i}`, shell(w, 25_000 - 100, 0, SHELL_SPEED, 0, FLIGHT_TICKS));
    });
    projectiles.set('bolt', shell('laser' as WeaponId, 25_000 - 300, 0, 400, 0, 600));
    expect(firstSnapIds([east], projectiles).get('east')).toEqual(['bolt']);
  });

  it('sub-capital projectiles keep the ±3,072 u box (a fall point in view does not send them)', () => {
    const projectiles = new Map<string, ProjectileRecord>([
      // Inside the box: sent.
      ['near', shell('laser' as WeaponId, 25_000 - 3000, 0, 400, 0, 600)],
      // Outside the box, ending right on the viewer: NOT sent.
      ['far', shell('laser' as WeaponId, 25_000 - 3200, 0, 3200 / 10, 0, 600)],
    ]);
    expect(firstSnapIds([east], projectiles).get('east')).toEqual(['near']);
  });
});
