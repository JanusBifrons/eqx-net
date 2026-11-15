/**
 * Probe 8 (mobile-perf-investigation, 2026-05-24) — extend mirror entry
 * pooling to lingering hulls, projectiles, and the
 * `handleSnapshot` snap-spread.
 *
 * Probe 7 pooled `mirror.ships` only. The o3dx44 capture (post-Probe-6+7)
 * showed allocation rate dropped from ~1-2 MB/sec to ~0.1 MB/sec — a
 * 10× win that broke the spiral for most of the session. Probe 8 attacks
 * the residual 0.1 MB/sec by pooling the remaining hot per-snapshot
 * mirror.set() sites:
 *
 *   - the parked-hull entry (handleSnapshot — per inactive hull; since
 *     RTS Part A S3 an entry in `mirror.ships`, pooled by the router)
 *   - mirror.projectiles.set (syncProjectiles — per in-flight projectile
 *     per snapshot)
 *   - snap = { ...snap, states: ... } → snap.states = ... (one alloc
 *     per snapshot saved)
 *
 * Same invariants as Probe 7:
 *   - First spawn allocates ONCE; subsequent updates mutate in place
 *   - Identity-only fields preserved across updates by NOT touching them
 *   - Map.size doesn't grow on repeated updates of the same id
 */
import { describe, it, expect } from 'vitest';
import type {
  ProjectileRenderState,
  RenderMirror,
  ShipRenderState,
} from '@core/contracts/IRenderer';
import type { SnapshotMessage } from '@shared-types/messages';
import { routeSnapshotShipStates, type ShipRouterCtx } from './snapshotShipRouter.js';

/**
 * Pure helpers that mirror the inline pooling patterns in
 * `ColyseusClient`. Extracted so the invariants can be locked
 * deterministically without spinning up a full client.
 */

interface ProjectileMaybePrev {
  prev: ProjectileRenderState | undefined;
  next: { x: number; y: number; vx: number; vy: number; ownerId: string; weaponId: string };
}

function updateProjectilePooled(
  projectiles: Map<string, ProjectileRenderState>,
  id: string,
  p: ProjectileMaybePrev['next'],
): void {
  const prev = projectiles.get(id);
  const isNew = !prev || prev.isGhost;
  if (isNew) {
    projectiles.set(id, {
      x: p.x, y: p.y, vx: p.vx, vy: p.vy,
      ownerId: p.ownerId,
      isGhost: false,
      weaponId: p.weaponId,
    });
  } else {
    // x/y preserved (client-integrated); refresh vx/vy + identity.
    prev.vx = p.vx;
    prev.vy = p.vy;
    prev.ownerId = p.ownerId;
    prev.isGhost = false;
    prev.weaponId = p.weaponId;
  }
}

/** RTS Part A S3: parked hulls are pooled in the ONE ship list by the REAL
 *  snapshot router (no more inline lingering-map copy to mirror here). */
function routerCtx(): ShipRouterCtx {
  const mirror = { ships: new Map(), localPlayerId: 'me', localShipInstanceId: null } as unknown as RenderMirror;
  return {
    mirror,
    hullSeenScratch: new Set<string>(),
    hullEvictScratch: [],
    dropShip: (k: string) => { mirror.ships.delete(k); },
  };
}

function routeHull(ctx: ShipRouterCtx, id: string, x: number, ownerPlayerId: string): ShipRenderState {
  const snap = {
    type: 'snapshot', serverTick: 1, ackedTick: 0,
    states: { [id]: { x, y: 2, vx: 0, vy: 0, angle: 0, angvel: 0, playerId: ownerPlayerId, isActive: false } },
  } as unknown as SnapshotMessage;
  routeSnapshotShipStates(snap, ctx);
  return ctx.mirror.ships.get(id)!;
}

describe('Probe 8 — projectile pooling', () => {
  it('first call creates new entry', () => {
    const m = new Map<string, ProjectileRenderState>();
    updateProjectilePooled(m, 'p1', { x: 10, y: 20, vx: 5, vy: 0, ownerId: 'a', weaponId: 'hitscan' });
    const e = m.get('p1');
    expect(e).toBeDefined();
    expect(e!.x).toBe(10);
    expect(e!.isGhost).toBe(false);
  });

  it('subsequent calls PRESERVE x/y (client-integrated) and refresh vx/vy/identity', () => {
    const m = new Map<string, ProjectileRenderState>();
    updateProjectilePooled(m, 'p1', { x: 10, y: 20, vx: 5, vy: 0, ownerId: 'a', weaponId: 'hitscan' });
    const ref = m.get('p1');
    // Client integrates x forward (simulates render-frame projectile motion).
    m.get('p1')!.x = 50;
    m.get('p1')!.y = 60;
    // Server snapshot fires with stale x/y but fresh vx/vy.
    updateProjectilePooled(m, 'p1', { x: 11, y: 21, vx: 5.1, vy: 0.1, ownerId: 'a', weaponId: 'hitscan' });
    const e = m.get('p1')!;
    expect(e).toBe(ref); // same object reference
    expect(e.x).toBe(50); // client-integrated x preserved (NOT snapped back to 11)
    expect(e.y).toBe(60); // same for y
    expect(e.vx).toBe(5.1); // vx refreshed
    expect(e.vy).toBe(0.1);
  });

  it('ghost re-resolution (prev.isGhost=true) re-creates with fresh pose', () => {
    const m = new Map<string, ProjectileRenderState>();
    // Initial ghost.
    m.set('p1', { x: 0, y: 0, vx: 0, vy: 0, ownerId: 'a', isGhost: true, weaponId: 'hitscan' });
    // Server snapshot with the real projectile.
    updateProjectilePooled(m, 'p1', { x: 100, y: 200, vx: 10, vy: 0, ownerId: 'a', weaponId: 'hitscan' });
    const e = m.get('p1')!;
    expect(e.x).toBe(100); // ghost → real means accept server x/y
    expect(e.isGhost).toBe(false);
  });
});

describe('Probe 8 — parked hull pooling (the snapshot router, one ship list)', () => {
  it('first snapshot creates the entry with the snapshot pose', () => {
    const ctx = routerCtx();
    const e = routeHull(ctx, 'l1', 1, 'p1');
    expect(e.x).toBe(1);
    expect(e.ownerPlayerId).toBe('p1');
    expect(e.isActive).toBe(false);
  });

  it('later snapshots reuse the SAME entry and keep kind/displayName from the sibling site', () => {
    const ctx = routerCtx();
    const ref = routeHull(ctx, 'l1', 1, 'p1');
    // syncMirror writes identity fields.
    ref.kind = 'interceptor';
    ref.displayName = 'Bob';
    const e = routeHull(ctx, 'l1', 99, 'p1');
    expect(e).toBe(ref); // same reference (pooled)
    // Pose after the seed is the remote body's (or the snapshot's while the
    // hull has no body: `spawnRemoteShipBodies`), never re-copied here.
    expect(e.kind).toBe('interceptor'); // preserved
    expect(e.displayName).toBe('Bob'); // preserved
  });
});

describe('Probe 8 — handleSnapshot snap.states mutation (avoiding spread)', () => {
  it('mutating snap.states in place is equivalent to { ...snap, states: translated }', () => {
    // Simulates the pre-fix vs post-fix shape. Both must produce a
    // snapshot whose `states` field is the new translated table while
    // preserving all other fields.
    const snap = {
      serverTick: 100,
      states: { 'orig-id': { playerId: 'p1', x: 0, y: 0 } as unknown },
      projectiles: [{ id: 'p1' }],
      drones: [],
    };
    const translated = { 'p1': { x: 0, y: 0 } };

    // Pre-fix shape: spread allocates a new outer object.
    const preFix = { ...snap, states: translated };
    expect(preFix).not.toBe(snap); // different object
    expect(preFix.projectiles).toBe(snap.projectiles); // but references are shared

    // Post-fix shape: mutate in place.
    snap.states = translated;
    expect(snap.states).toBe(translated);
    expect(snap.projectiles).toBeDefined(); // other fields intact
    expect(snap.serverTick).toBe(100);
  });
});

describe('Probe 8 — allocation-count parity sweep (projectiles + lingering)', () => {
  it('100 updates × 10 projectiles + 10 lingering → 20 Map entries total, no growth', () => {
    const proj = new Map<string, ProjectileRenderState>();
    const ctx = routerCtx();
    for (let pass = 0; pass < 100; pass++) {
      const states: Record<string, unknown> = {};
      for (let i = 0; i < 10; i++) {
        updateProjectilePooled(proj, `p${i}`, { x: pass, y: 0, vx: 1, vy: 0, ownerId: 'a', weaponId: 'h' });
        states[`l${i}`] = { x: pass, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, playerId: 'p', isActive: false };
      }
      routeSnapshotShipStates({ type: 'snapshot', serverTick: pass, ackedTick: 0, states } as unknown as SnapshotMessage, ctx);
    }
    expect(proj.size).toBe(10);
    expect(ctx.mirror.ships.size).toBe(10);
  });
});
