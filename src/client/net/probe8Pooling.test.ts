/**
 * Probe 8 (mobile-perf-investigation, 2026-05-24) — extend mirror entry
 * pooling to wrecks, lingering hulls, projectiles, and the
 * `handleSnapshot` snap-spread.
 *
 * Probe 7 pooled `mirror.ships` only. The o3dx44 capture (post-Probe-6+7)
 * showed allocation rate dropped from ~1-2 MB/sec to ~0.1 MB/sec — a
 * 10× win that broke the spiral for most of the session. Probe 8 attacks
 * the residual 0.1 MB/sec by pooling the remaining hot per-snapshot
 * mirror.set() sites:
 *
 *   - mirror.lingeringShips.set (handleSnapshot — per inactive hull
 *     per snapshot)
 *   - mirror.projectiles.set (syncProjectiles — per in-flight projectile
 *     per snapshot)
 *   - mirror.wrecks.set (syncMirror — per wreck per identity-update)
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
  WreckRenderState,
  LingeringShipRenderState,
} from '@core/contracts/IRenderer';

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

function updateWreckPooled(
  wrecks: Map<string, WreckRenderState>,
  id: string,
  identity: { kind: string; health: number; maxHealth: number },
): WreckRenderState {
  let entry = wrecks.get(id);
  if (!entry) {
    entry = {
      shipInstanceId: id,
      x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
      kind: identity.kind,
      health: identity.health,
      maxHealth: identity.maxHealth,
    };
    wrecks.set(id, entry);
  } else {
    entry.kind = identity.kind;
    entry.health = identity.health;
    entry.maxHealth = identity.maxHealth;
    // pose untouched — owned by sibling sync site
  }
  return entry;
}

function updateLingeringPooled(
  lingering: Map<string, LingeringShipRenderState>,
  id: string,
  pose: { x: number; y: number; vx: number; vy: number; angle: number; ownerPlayerId: string },
): LingeringShipRenderState {
  let entry = lingering.get(id);
  if (!entry) {
    entry = { ...pose };
    lingering.set(id, entry);
  } else {
    entry.x = pose.x;
    entry.y = pose.y;
    entry.vx = pose.vx;
    entry.vy = pose.vy;
    entry.angle = pose.angle;
    entry.ownerPlayerId = pose.ownerPlayerId;
  }
  return entry;
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

describe('Probe 8 — wreck pooling', () => {
  it('first call creates new entry with pose zeros (pose owned by sibling site)', () => {
    const m = new Map<string, WreckRenderState>();
    updateWreckPooled(m, 'w1', { kind: 'fighter', health: 50, maxHealth: 100 });
    const e = m.get('w1')!;
    expect(e.shipInstanceId).toBe('w1');
    expect(e.x).toBe(0); // pose-write hasn't happened yet
    expect(e.kind).toBe('fighter');
    expect(e.health).toBe(50);
  });

  it('subsequent calls UPDATE identity, preserve pose written by sibling site', () => {
    const m = new Map<string, WreckRenderState>();
    updateWreckPooled(m, 'w1', { kind: 'fighter', health: 50, maxHealth: 100 });
    // Simulate sibling pose-write (syncWreckPoses).
    const ref = m.get('w1')!;
    ref.x = 123; ref.y = 456; ref.angle = 1.5;
    // Schema diff updates health.
    updateWreckPooled(m, 'w1', { kind: 'fighter', health: 30, maxHealth: 100 });
    expect(m.get('w1')!).toBe(ref); // same reference
    expect(m.get('w1')!.x).toBe(123); // pose preserved
    expect(m.get('w1')!.y).toBe(456);
    expect(m.get('w1')!.angle).toBe(1.5);
    expect(m.get('w1')!.health).toBe(30); // identity updated
  });

  it('Map size does not grow on repeated identity updates', () => {
    const m = new Map<string, WreckRenderState>();
    updateWreckPooled(m, 'w1', { kind: 'fighter', health: 50, maxHealth: 100 });
    for (let h = 49; h >= 0; h--) {
      updateWreckPooled(m, 'w1', { kind: 'fighter', health: h, maxHealth: 100 });
    }
    expect(m.size).toBe(1);
  });
});

describe('Probe 8 — lingering hull pooling (handleSnapshot path)', () => {
  it('first call creates new entry with provided pose', () => {
    const m = new Map<string, LingeringShipRenderState>();
    updateLingeringPooled(m, 'l1', { x: 1, y: 2, vx: 3, vy: 4, angle: 0.5, ownerPlayerId: 'p1' });
    const e = m.get('l1')!;
    expect(e.x).toBe(1);
    expect(e.ownerPlayerId).toBe('p1');
  });

  it('subsequent calls mutate pose, preserve kind/displayName added by sibling site', () => {
    const m = new Map<string, LingeringShipRenderState>();
    updateLingeringPooled(m, 'l1', { x: 1, y: 2, vx: 0, vy: 0, angle: 0, ownerPlayerId: 'p1' });
    // Simulate syncMirror writing identity fields.
    const ref = m.get('l1')!;
    ref.kind = 'interceptor';
    ref.displayName = 'Bob';
    // Next snapshot updates pose.
    updateLingeringPooled(m, 'l1', { x: 99, y: 88, vx: 5, vy: 6, angle: 1.0, ownerPlayerId: 'p1' });
    const e = m.get('l1')!;
    expect(e).toBe(ref); // same reference
    expect(e.x).toBe(99); // pose updated
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
      wrecks: [],
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

describe('Probe 8 — allocation-count parity sweep (all three entry types)', () => {
  it('100 updates × 10 projectiles + 10 wrecks + 10 lingering → 30 Map entries total, no growth', () => {
    const proj = new Map<string, ProjectileRenderState>();
    const wrk = new Map<string, WreckRenderState>();
    const ling = new Map<string, LingeringShipRenderState>();
    for (let pass = 0; pass < 100; pass++) {
      for (let i = 0; i < 10; i++) {
        updateProjectilePooled(proj, `p${i}`, { x: pass, y: 0, vx: 1, vy: 0, ownerId: 'a', weaponId: 'h' });
        updateWreckPooled(wrk, `w${i}`, { kind: 'fighter', health: 100 - pass, maxHealth: 100 });
        updateLingeringPooled(ling, `l${i}`, { x: pass, y: 0, vx: 0, vy: 0, angle: 0, ownerPlayerId: 'p' });
      }
    }
    expect(proj.size).toBe(10);
    expect(wrk.size).toBe(10);
    expect(ling.size).toBe(10);
  });
});
