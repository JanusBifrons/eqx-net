/**
 * Heap-delta lock for SnapshotBroadcaster's per-broadcast scratches
 * (plan: quirky-rabbit, Phase 2).
 *
 * The class-field scratches `_allShipsScratch`, `_aliveIdsScratch`,
 * `_ackedTicksMapScratch`, `_boostingIdsScratch`, `_thrustingIdsScratch`
 * replaced six fresh allocations per broadcast (the array literal,
 * Set literal, Record literal, two array literals, and the sharedTail
 * object literal). This test runs `broadcast()` repeatedly with a
 * stubbed deps surface and asserts post-warmup heap growth is bounded.
 *
 * Workload: 0 clients. The global pre-recipient block populates the
 * scratches; the per-recipient loop is a no-op; the telemetry block
 * is gated off (`anySnapshotSent` stays false). So ANY heap growth
 * across 1000 broadcasts is a sign the scratches stopped recycling.
 *
 * Why 0 clients instead of stubbed Colyseus clients: the per-recipient
 * allocations (states, projectiles, drones, wrecks, snap) are NOT
 * pooled in Phase 2 — they're allocated fresh per recipient and
 * passed to `client.send()`. Pooling them needs wire-safety analysis
 * deferred to a follow-up commit. With 0 clients we test exactly the
 * global-block migration this commit landed.
 *
 * Run with `pnpm test:gc`.
 */
import { describe, it, expect } from 'vitest';
import type { Client, ClientArray } from 'colyseus';
import type { Logger } from 'pino';
import type { MapSchema } from '@colyseus/schema';
import { SnapshotBroadcaster, type SnapshotBroadcasterDeps } from './SnapshotBroadcaster.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { ShipState } from './schema/SectorState.js';
import type { ProjectileRecord } from './ProjectilePipeline.js';

function requireGc(): () => void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') {
    throw new Error('global.gc not available — run via `pnpm test:gc`.');
  }
  return gc;
}

function postGcHeap(): number {
  const gc = requireGc();
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

function makeDeps(playerCount: number): { deps: SnapshotBroadcasterDeps; broadcaster: SnapshotBroadcaster } {
  const sabU32 = new Uint32Array(1024);
  const playerToSlot = new Map<string, number>();
  const shipPoseCache = new Map<string, ShipPhysicsState>();
  const ships = new Map<string, ShipState>();
  for (let i = 0; i < playerCount; i++) {
    const pid = `p${i}`;
    playerToSlot.set(pid, i);
    const pose: ShipPhysicsState = { x: i * 10, y: i * 10, vx: 0, vy: 0, angle: 0, angvel: 0 };
    shipPoseCache.set(pid, pose);
    ships.set(pid, {
      alive: true,
      isActive: true,
      shipInstanceId: `inst-${pid}`,
      playerId: pid,
    } as unknown as ShipState);
  }

  const stubLogger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    fatal: () => {}, trace: () => {}, silent: () => {},
    child: () => stubLogger,
  } as unknown as Logger;

  const deps: SnapshotBroadcasterDeps = {
    serverTick: () => 100,
    sabU32,
    // 0 clients — exercises the global pre-recipient block only.
    clients: [] as unknown as ClientArray<Client>,
    sessionToPlayer: new Map(),
    playerToSlot,
    getActiveShip: (pid: string) => ships.get(pid),
    shipPoseCache,
    lingeringSlots: new Map<string, number>(),
    lingeringPoseCache: new Map<string, ShipPhysicsState>(),
    // MapSchema duck-types as Map for our purposes (we only call .get).
    shipsMap: ships as unknown as MapSchema<ShipState>,
    wreckPoseCache: new Map<string, ShipPhysicsState>(),
    liveProjectiles: new Map<string, ProjectileRecord>(),
    boostingPlayers: new Set<string>(),
    thrustingPlayers: new Set<string>(),
    swarmRegistry: { getByEntityId: () => null },
    playerMountAngles: new Map<string, Float32Array>(),
    droneMountAngles: new Map<string, Float32Array>(),
    logger: stubLogger,
    serverLogEvent: () => {},
  };

  return { deps, broadcaster: new SnapshotBroadcaster(deps) };
}

describe('SnapshotBroadcaster heap-delta (Phase 2 pool migration)', () => {
  it('broadcast() with 0 clients does not grow heap under sustained calls', () => {
    const { broadcaster } = makeDeps(10);

    // Warmup: prime the JIT + the AllShipEntry slot pool. The first
    // N calls allocate the slot instances; subsequent calls reuse.
    for (let i = 0; i < 1000; i++) broadcaster.broadcast(false);

    const before = postGcHeap();
    for (let i = 0; i < 5000; i++) broadcaster.broadcast(false);
    const after = postGcHeap();

    const growthBytes = after - before;
    // Tolerance: 200 KB across 5000 broadcasts. The pooled path
    // should be essentially flat (a few KB drift from V8 internals
    // and the test's own bookkeeping). A regression where the
    // scratches stop recycling would balloon to MB.
    expect(growthBytes).toBeLessThan(200_000);
  });

  it('broadcast() reuses _allShipsScratch instances across calls', () => {
    const { broadcaster, deps } = makeDeps(5);
    broadcaster.broadcast(false);
    // Access the internal field for the identity assertion. This
    // test deliberately reaches into the implementation — the pooled
    // identity IS the contract we're locking.
    const after1 = (broadcaster as unknown as { _allShipsScratch: unknown[] })._allShipsScratch;
    const slot0 = after1[0];
    broadcaster.broadcast(false);
    const after2 = (broadcaster as unknown as { _allShipsScratch: unknown[] })._allShipsScratch;
    expect(after2).toBe(after1); // same array
    expect(after2[0]).toBe(slot0); // same entry instance
    // Sanity — verify the deps loop produced 5 entries each time.
    expect(deps.playerToSlot.size).toBe(5);
    expect(after2.length).toBe(5);
  });
});
