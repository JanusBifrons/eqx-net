/**
 * Regression: after a DISPLACE respawn the local player owns TWO hulls under
 * the same playerId — the old lingering hull (isActive=false) and the new
 * active ship — and the client must bind to the NEW ACTIVE ship, not the
 * stale lingering one.
 *
 * USER REPORTED (2026-06-03 smoke): "Spawned as an interceptor in Sol. Went
 * back to menu. Spawned in as another interceptor... respawned me in that
 * same interceptor and I couldn't move. I didn't see the ship I left to
 * linger either... AI ships were shooting the 'lingering' ship despite it
 * being invisible."
 *
 * Diagnosis: `routeSnapshotShipStates` identified the OWN ship by `playerId`
 * (`isOwnShip = entry.playerId === localPlayerId`). A displaced player has two
 * entries with that playerId. The old displaced hull (isActive=false) was
 * exempted from lingering routing (`!isOwnShip`) and written to
 * `statesByPlayerId[playerId]` — colliding with the new active ship.
 * `for…in` is insertion order, so when the old hull is serialised AFTER the
 * new ship it WINS, binding the local view to the uncontrollable lingering
 * hull (server has the player in the new active ship, so drones target it).
 *
 * Fix: identify the own ACTIVE ship by `localShipInstanceId` (from welcome);
 * the own displaced hull must NOT clobber the active ship and must not render
 * for the owner.
 */
import { describe, it, expect } from 'vitest';
import { routeSnapshotShipStates, type ShipRouterCtx } from './snapshotShipRouter.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';

function makeCtx(localPlayerId: string, localShipInstanceId: string): ShipRouterCtx {
  const mirror = {
    ships: new Map(),
    lingeringShips: new Map(),
    localPlayerId,
    localShipInstanceId,
  } as unknown as RenderMirror;
  return {
    mirror,
    predWorld: null,
    lingerBodies: { despawn: () => {} } as unknown as ShipRouterCtx['lingerBodies'],
    tryEnsureLingerPredBody: () => {},
    lingeringSeenScratch: new Set<string>(),
    lingeringToEvictScratch: [],
  };
}

describe('routeSnapshotShipStates — own active ship binds by shipInstanceId, not playerId', () => {
  it('binds the local view to the NEW active ship even when the old displaced hull is serialised last', () => {
    const ctx = makeCtx('P', 'NEW');
    // Insertion order: NEW (active) FIRST, OLD displaced hull LAST — so under
    // the playerId-keyed bug the old hull overwrites statesByPlayerId['P'].
    const snap: SnapshotMessage = {
      type: 'snapshot',
      serverTick: 1,
      ackedTick: 0,
      states: {
        NEW: { x: 500, y: 500, vx: 0, vy: 0, angle: 0, angvel: 0, playerId: 'P', isActive: true },
        OLD: { x: 10, y: 10, vx: 0, vy: 0, angle: 0, angvel: 0, playerId: 'P', isActive: false },
      },
    } as unknown as SnapshotMessage;

    routeSnapshotShipStates(snap, ctx);

    const bound = snap.states['P'];
    expect(bound, 'the local player must be bound to an active-ship entry').toBeDefined();
    expect(
      bound!.x,
      [
        'After a displace, the local view bound to the OLD lingering hull (10,10)',
        'instead of the NEW active ship (500,500) — the "pinned in my old',
        'interceptor" bug. routeSnapshotShipStates must identify the own ACTIVE',
        'ship by shipInstanceId (localShipInstanceId), not playerId.',
      ].join('\n'),
    ).toBe(500);

    // The owner MUST see their own displaced hull as a lingering hull — the
    // player's pool is visible in-world (2026-06-03 "I can't see the lingering
    // ships" report; the original requirement is "see their own ship there").
    // It is routed to lingeringShips (rendered) WITHOUT clobbering the active
    // ship at statesByPlayerId[playerId].
    const ownLinger = ctx.mirror.lingeringShips!.get('OLD');
    expect(ownLinger, 'owner must see their own displaced hull as a lingering hull').toBeTruthy();
    expect(ownLinger!.ownerPlayerId).toBe('P');
    expect(ownLinger!.x).toBe(10);
  });

  it('keeps the own pending-join ship active during the handshake (isActive=false but it IS the welcome ship)', () => {
    const ctx = makeCtx('P', 'NEW');
    // The own joining ship arrives isActive=false during the pending-join
    // handshake; it must stay bound (not routed to lingering) so the bootstrap
    // chain proceeds.
    const snap: SnapshotMessage = {
      type: 'snapshot',
      serverTick: 1,
      ackedTick: 0,
      states: {
        NEW: { x: 320, y: 240, vx: 0, vy: 0, angle: 0, angvel: 0, playerId: 'P', isActive: false },
      },
    } as unknown as SnapshotMessage;

    routeSnapshotShipStates(snap, ctx);

    expect(snap.states['P'], 'own pending-join ship must stay bound').toBeDefined();
    expect(snap.states['P']!.x).toBe(320);
    expect(ctx.mirror.lingeringShips!.has('NEW')).toBe(false);
  });

  it('still routes OTHER players’ lingering hulls to lingeringShips', () => {
    const ctx = makeCtx('P', 'NEW');
    const snap: SnapshotMessage = {
      type: 'snapshot',
      serverTick: 1,
      ackedTick: 0,
      states: {
        NEW: { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, playerId: 'P', isActive: true },
        OTHER: { x: 77, y: 88, vx: 0, vy: 0, angle: 0, angvel: 0, playerId: 'Q', isActive: false },
      },
    } as unknown as SnapshotMessage;

    routeSnapshotShipStates(snap, ctx);

    expect(snap.states['P']).toBeDefined();
    expect(snap.states['Q'], 'other-player lingering hull must NOT be an active entry').toBeUndefined();
    expect(ctx.mirror.lingeringShips!.get('OTHER')?.ownerPlayerId).toBe('Q');
  });
});
