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
 *
 * RTS Part A S3: ONE ship list. A parked hull is an ordinary `mirror.ships`
 * entry under its shipInstanceId (`isActive: false`); its snapshot state rides
 * under the same key; a hull missing from a snapshot goes through the ONE
 * remote-ship drop path.
 */
import { describe, it, expect } from 'vitest';
import { routeSnapshotShipStates, type ShipRouterCtx } from './snapshotShipRouter.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';

/** The drop path is the client's `dropRemoteShip`, stubbed here to delete the
 *  mirror entry and record the key. */
function makeCtx(localPlayerId: string, localShipInstanceId: string): ShipRouterCtx & { dropped: string[] } {
  const mirror = {
    ships: new Map(),
    localPlayerId,
    localShipInstanceId,
  } as unknown as RenderMirror;
  const dropped: string[] = [];
  return {
    mirror,
    hullSeenScratch: new Set<string>(),
    hullEvictScratch: [],
    dropShip: (key: string) => { dropped.push(key); mirror.ships.delete(key); },
    dropped,
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

    // The owner MUST see their own displaced hull — the player's pool is
    // visible in-world (2026-06-03 "I can't see the lingering ships" report).
    // It is a parked hull in the one ship list under its shipInstanceId,
    // WITHOUT clobbering the active ship's playerId key.
    const ownLinger = ctx.mirror.ships.get('OLD');
    expect(ownLinger, 'owner must see their own displaced hull').toBeTruthy();
    expect(ownLinger!.ownerPlayerId).toBe('P');
    expect(ownLinger!.x).toBe(10);
    expect(ownLinger!.isActive).toBe(false);
    // Its snapshot state rides under its own key, for the remote-ship path.
    expect(snap.states['OLD']?.x).toBe(10);
  });

  it('keeps the own pending-join ship active during the handshake (isActive=false but it IS the welcome ship)', () => {
    const ctx = makeCtx('P', 'NEW');
    // The own joining ship arrives isActive=false during the pending-join
    // handshake; it must stay bound (not a parked hull) so the bootstrap
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
    expect(ctx.mirror.ships.has('NEW')).toBe(false);
  });

  it('still routes OTHER players’ parked hulls to their own shipInstanceId key', () => {
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
    expect(snap.states['Q'], 'other-player parked hull must NOT be keyed by its owner').toBeUndefined();
    expect(ctx.mirror.ships.get('OTHER')?.ownerPlayerId).toBe('Q');
    expect(ctx.mirror.ships.get('OTHER')?.isActive).toBe(false);
  });

  it('evicts a hull missing from the next snapshot through the ONE drop path, never a pilot\'s entry', () => {
    const ctx = makeCtx('P', 'NEW');
    // A remote pilot's entry (syncMirror owns its lifetime) is in the list too.
    ctx.mirror.ships.set('R', { x: 0, y: 0, vx: 0, vy: 0, angle: 0, ownerPlayerId: 'R', isActive: true });
    const first = {
      type: 'snapshot', serverTick: 1, ackedTick: 0,
      states: { H: { x: 1, y: 2, vx: 0, vy: 0, angle: 0, angvel: 0, playerId: 'Q', isActive: false } },
    } as unknown as SnapshotMessage;
    routeSnapshotShipStates(first, ctx);
    expect(ctx.mirror.ships.has('H')).toBe(true);
    const second = { type: 'snapshot', serverTick: 2, ackedTick: 0, states: {} } as unknown as SnapshotMessage;
    routeSnapshotShipStates(second, ctx);
    expect(ctx.dropped).toEqual(['H']);
    expect(ctx.mirror.ships.has('H')).toBe(false);
    expect(ctx.mirror.ships.has('R'), 'an active pilot is never evicted by the hull sweep').toBe(true);
  });

  it('copies no per-field hull state (level / mounts / shield ride the shared apply paths)', () => {
    const ctx = makeCtx('P', 'NEW');
    const snap = {
      type: 'snapshot', serverTick: 1, ackedTick: 0,
      states: { H: { x: 1, y: 2, vx: 0, vy: 0, angle: 0, angvel: 0, playerId: 'Q', isActive: false, level: 4, shieldDown: true, mounts: [{ slotId: 'a', weaponId: 'b' }] } },
    } as unknown as SnapshotMessage;
    routeSnapshotShipStates(snap, ctx);
    const h = ctx.mirror.ships.get('H')!;
    expect(h.level).toBeUndefined();
    expect(h.activatedMounts).toBeUndefined();
    expect(h.shieldDown).toBeUndefined();
  });
});

/**
 * Bug (perf-plan test audit, 2026-11-06; spectator-mode.spec round trip):
 * Spectate parks the ship you were flying (server: displaceActiveHullToLingering,
 * same shipInstanceId, isActive=false). The pending-join exemption above kept
 * that parked hull keyed as the ship you fly, so it never became a parked
 * hull and the Pilot menu (which lists your parked ships) was always empty:
 * you could not get back into the ship you just left.
 */
describe('routeSnapshotShipStates — a spectating player sees their parked ship', () => {
  it('routes the own inactive hull to its shipInstanceId key while spectating', () => {
    const ctx = makeCtx('P', 'S1');
    ctx.localSpectating = true;
    const snap = {
      type: 'snapshot', serverTick: 1, ackedTick: 0,
      states: { S1: { x: 7, y: 8, vx: 0, vy: 0, angle: 0, angvel: 0, playerId: 'P', isActive: false } },
    } as unknown as SnapshotMessage;
    routeSnapshotShipStates(snap, ctx);
    expect(ctx.mirror.ships.get('S1')?.ownerPlayerId, 'the parked hull is listed as yours').toBe('P');
    expect(snap.states['P'], 'and it is not bound as the ship you are flying').toBeUndefined();
  });

  it('keeps the pending-join exemption when not spectating', () => {
    const ctx = makeCtx('P', 'S1');
    ctx.localSpectating = false;
    const snap = {
      type: 'snapshot', serverTick: 1, ackedTick: 0,
      states: { S1: { x: 7, y: 8, vx: 0, vy: 0, angle: 0, angvel: 0, playerId: 'P', isActive: false } },
    } as unknown as SnapshotMessage;
    routeSnapshotShipStates(snap, ctx);
    expect(snap.states['P']?.x).toBe(7);
    expect(ctx.mirror.ships.has('S1')).toBe(false);
  });
});
