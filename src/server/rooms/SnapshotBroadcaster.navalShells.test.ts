/**
 * Naval-shell interest (real-scale ranges, slice 7).
 *
 * A 16" shell flies up to ~38.7 km for ~30 s. The old projectile interest was
 * a ±3,072 u box around the viewer (plus "a wide owner in your interest"), so
 * the ship being shot at from 25 km saw nothing until the shell was 3 km out.
 * Now a `naval_*` shell rides a viewer's snapshot while the shell OR its fall
 * point is inside the viewer's widest camera view for the hull it flies
 * (`shellViewHalfExtent`). Sub-capital projectiles keep the box rule.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Client, ClientArray } from 'colyseus';
import type { Logger } from 'pino';
import type { MapSchema } from '@colyseus/schema';
import { Packr } from '@colyseus/msgpackr';
import { SnapshotBroadcaster, navalShellInView, type SnapshotBroadcasterDeps } from './SnapshotBroadcaster.js';
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

describe('navalShellInView', () => {
  it('is true for the shell itself in view, or for its fall point in view, else false', () => {
    const p = shell('naval_xl', 0, 0, SHELL_SPEED, 0, FLIGHT_TICKS);
    expect(navalShellInView(p, 1000, 0, 6400, TICK)).toBe(true); // the shell
    expect(navalShellInView(p, 25_000, 0, 6400, TICK)).toBe(true); // its fall point
    expect(navalShellInView(p, 12_500, 20_000, 6400, TICK)).toBe(false); // neither
    // Once its flight is spent, only the shell itself counts.
    expect(navalShellInView(p, 25_000, 0, 6400, TICK + FLIGHT_TICKS)).toBe(false);
  });
});

describe('SnapshotBroadcaster — naval shells reach viewers by their widest view', () => {
  const viewers: Viewer[] = [
    { pid: 'east', kind: 'fighter', x: 25_000, y: 0 }, // where the salvo falls
    { pid: 'north', kind: 'fighter', x: 0, y: 40_000 }, // far from path and fall
    { pid: 'bbview', kind: 'battleship', x: 0, y: 28_000 }, // wide view: fall point inside
    { pid: 'ftview', kind: 'fighter', x: 0, y: 28_000 }, // same spot, fighter view: outside
  ];

  it('the target 25 km from a firing battleship gets the shell from its FIRST snapshot; a far viewer does not', () => {
    const projectiles = new Map<string, ProjectileRecord>([
      ['proj-1', shell('naval_xl', 0, 0, SHELL_SPEED, 0, FLIGHT_TICKS)],
    ]);
    const ids = firstSnapIds(viewers, projectiles);
    expect(ids.get('east')).toEqual(['proj-1']);
    expect(ids.get('north')).toEqual([]);
    // Radius follows the viewer's hull: a battleship sees the fall point from
    // 28 km away, a fighter in the same place does not.
    expect(ids.get('bbview')).toEqual(['proj-1']);
    expect(ids.get('ftview')).toEqual([]);
  });

  it('every naval calibre is covered (naval_s … naval_siege)', () => {
    const projectiles = new Map<string, ProjectileRecord>();
    const calibres: WeaponId[] = ['naval_s', 'naval_m', 'naval_l', 'naval_xl', 'naval_xxl', 'naval_siege'];
    calibres.forEach((w, i) => projectiles.set(`proj-${i}`, shell(w, 0, 0, SHELL_SPEED, 0, FLIGHT_TICKS)));
    const ids = firstSnapIds([viewers[0]!], projectiles);
    expect(ids.get('east')!.length).toBe(calibres.length);
  });

  it('sub-capital projectiles keep the ±3,072 u box (a fall point in view does not send them)', () => {
    const projectiles = new Map<string, ProjectileRecord>([
      // Inside the box: sent.
      ['near', shell('laser' as WeaponId, 25_000 - 3000, 0, 400, 0, 600)],
      // Outside the box, ending right on the viewer: NOT sent.
      ['far', shell('laser' as WeaponId, 25_000 - 3200, 0, 3200 / 10, 0, 600)],
    ]);
    const ids = firstSnapIds([viewers[0]!], projectiles);
    expect(ids.get('east')).toEqual(['near']);
  });

  it('byte cost: one battleship broadside (9 × 16") on a far target', () => {
    const salvo = new Map<string, ProjectileRecord>();
    for (let i = 0; i < 9; i++) {
      salvo.set(`proj-${1000 + i}`, shell('naval_xl', (i % 3) * 30, Math.floor(i / 3) * 40, SHELL_SPEED, 0, FLIGHT_TICKS));
    }
    const target = [viewers[0]!];
    const withShells = makeDeps(target, salvo);
    const empty = makeDeps(target, new Map());
    for (const run of [withShells, empty]) {
      const b = new SnapshotBroadcaster(run.deps);
      for (let i = 0; i < 60 && run.firstSnaps.size === 0; i++) b.broadcast(false);
    }
    const full = withShells.bytes.get('s-east')!;
    const base = empty.bytes.get('s-east')!;
    const perShell = (full - base) / 9;
    // Visible cost: printed for the PR, bounded so a wire bloat is caught.
    console.log(`[naval-shell bytes] snapshot ${base} B → ${full} B with a 9-shell salvo `
      + `(+${full - base} B, ${perShell.toFixed(1)} B/shell; ×20 Hz = ${((full - base) * 20 / 1024).toFixed(2)} KB/s per viewer while in flight)`);
    expect(withShells.firstSnaps.get('s-east')!.projectiles!.length).toBe(9);
    expect(perShell).toBeLessThan(96);
  });
});
