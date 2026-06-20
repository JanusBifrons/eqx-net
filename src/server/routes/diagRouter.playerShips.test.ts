/**
 * Contract tests for the Phase 3 multi-ship roster diag endpoints. These
 * lock the wire shape the client roster panel consumes — the panel was
 * mysteriously empty in playtest while the DB clearly had rows, so the
 * suspect surfaces here are:
 *   - response shape mismatch (the panel parses `body.ships` as an array
 *     of RosterShipEntry — the handler must emit exactly that field)
 *   - abandon over-gating (the playtest fix removed the 409 check; this
 *     test fails the moment that check is reinstated)
 *
 * We invoke the handlers directly with a stubbed PlayerShipStore via
 * `setPlayerShipStore`. No Express round-trip — the goal is to nail the
 * handler logic without depending on HTTP plumbing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { PlayerShipStore } from '../playerShips/PlayerShipStore.js';

// Mocks must run before the diagRouter import below — that module pulls
// in Database / matchmaker transitively, which vitest's node-only resolver
// can't load. We stub the persistence singleton + the db handle so the
// import chain stops short of node:sqlite.
const storeRef = { current: null as PlayerShipStore | null };

vi.mock('../db/PersistenceWorker.js', () => ({
  getPlayerShipStore: () => {
    if (storeRef.current === null) throw new Error('test bug: store not set before handler call');
    return storeRef.current;
  },
  setPlayerShipStore: (s: PlayerShipStore) => { storeRef.current = s; },
  persistence: {
    enqueueCritical: () => {},
    enqueueVolatile: () => {},
    enqueueCriticalAwaitable: () => Promise.resolve({}),
    shutdown: () => Promise.resolve({ drained: 0 }),
  },
}));

vi.mock('../db/Database.js', () => ({ db: { prepare: () => ({ all: () => [] }) } }));

vi.mock('colyseus', () => ({ matchMaker: {} }));

import { devPlayerShipsHandler, devPlayerShipsAbandonHandler } from './diagRouter.js';
import { setPlayerShipStore } from '../db/PersistenceWorker.js';

function makeReq(opts: { query?: Record<string, unknown>; params?: Record<string, string>; body?: unknown }): Request {
  return {
    query: opts.query ?? {},
    params: opts.params ?? {},
    body: opts.body ?? {},
  } as unknown as Request;
}

function makeRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 200,
    _json: undefined as unknown,
    status(code: number) { this._status = code; return this; },
    json(body: unknown) { this._json = body; return this; },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

let nextId = 0;
function uid(): string {
  nextId++;
  return `ship-${String(nextId).padStart(4, '0')}`;
}

function freshStore(): PlayerShipStore {
  nextId = 0;
  return new PlayerShipStore({ generateShipId: uid, now: () => 1_000_000 });
}

describe('devPlayerShipsHandler', () => {
  let store: PlayerShipStore;

  beforeEach(() => {
    store = freshStore();
    setPlayerShipStore(store);
  });

  it('returns 400 when playerId is missing', () => {
    const req = makeReq({ query: {} });
    const res = makeRes();
    devPlayerShipsHandler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns { playerId, ships:[] } for a player with no roster', () => {
    const req = makeReq({ query: { playerId: 'p-empty' } });
    const res = makeRes();
    devPlayerShipsHandler(req, res);
    expect(res._json).toEqual({ playerId: 'p-empty', ships: [] });
  });

  it('emits the exact field names the client panel consumes', () => {
    const ship = store.create({
      playerId: 'p1',
      userId: 'user-a',
      kind: 'fighter',
      sectorKey: 'sol-prime',
      x: 100,
      y: -200,
      health: 350,
    });
    store.markActive(ship.shipId, 'room-xyz', {
      x: 100, y: -200, vx: 0, vy: 0, angle: 0.5, angvel: 0, health: 350, lastFireClientTick: 7,
    });
    const req = makeReq({ query: { playerId: 'p1' } });
    const res = makeRes();
    devPlayerShipsHandler(req, res);
    const body = res._json as { playerId: string; ships: Array<Record<string, unknown>> };
    expect(body.playerId).toBe('p1');
    expect(body.ships).toHaveLength(1);
    const entry = body.ships[0]!;
    // Wire-shape contract — client `RosterShipEntry` reads these names.
    // Adding fields is fine; renaming or removing is a breaking change.
    expect(Object.keys(entry).sort()).toEqual(
      ['activeRoomId', 'createdAt', 'expiresAt', 'isActive', 'kind', 'kindVersion', 'sectorKey', 'shipId', 'updatedAt', 'x', 'y', 'health', 'level', 'xp', 'statAlloc', 'mounts'].sort(),
    );
    expect(entry['isActive']).toBe(true);
    expect(entry['activeRoomId']).toBe('room-xyz');
    expect(entry['kind']).toBe('fighter');
    expect(entry['x']).toBe(100);
    expect(entry['y']).toBe(-200);
    expect(entry['health']).toBe(350);
  });

  it('only returns the queried playerId\'s ships', () => {
    store.create({ playerId: 'p1', userId: null, kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
    store.create({ playerId: 'p2', userId: null, kind: 'scout',   sectorKey: 's', x: 0, y: 0, health: 100 });
    const req = makeReq({ query: { playerId: 'p1' } });
    const res = makeRes();
    devPlayerShipsHandler(req, res);
    const body = res._json as { ships: Array<{ kind: string }> };
    expect(body.ships).toHaveLength(1);
    expect(body.ships[0]!.kind).toBe('fighter');
  });
});

describe('devPlayerShipsAbandonHandler', () => {
  let store: PlayerShipStore;

  beforeEach(() => {
    store = freshStore();
    setPlayerShipStore(store);
  });

  it('returns 400 when shipId or playerId missing', () => {
    const res = makeRes();
    devPlayerShipsAbandonHandler(makeReq({ params: {}, body: { playerId: 'p1' } }), res);
    expect(res._status).toBe(400);

    const res2 = makeRes();
    devPlayerShipsAbandonHandler(makeReq({ params: { shipId: 's1' }, body: {} }), res2);
    expect(res2._status).toBe(400);
  });

  it('returns 404 when the ship does not exist', () => {
    const res = makeRes();
    devPlayerShipsAbandonHandler(
      makeReq({ params: { shipId: 'ghost' }, body: { playerId: 'p1' } }),
      res,
    );
    expect(res._status).toBe(404);
  });

  it('returns 403 when the ship is owned by a different player', () => {
    const ship = store.create({ playerId: 'p1', userId: null, kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
    const res = makeRes();
    devPlayerShipsAbandonHandler(
      makeReq({ params: { shipId: ship.shipId }, body: { playerId: 'attacker' } }),
      res,
    );
    expect(res._status).toBe(403);
    // Ship must still exist after the rejected abandon.
    expect(store.get(ship.shipId)).not.toBeNull();
  });

  it('allows abandoning a stored ship', () => {
    const ship = store.create({ playerId: 'p1', userId: null, kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
    const res = makeRes();
    devPlayerShipsAbandonHandler(
      makeReq({ params: { shipId: ship.shipId }, body: { playerId: 'p1' } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ ok: true, shipId: ship.shipId });
    expect(store.get(ship.shipId)).toBeNull();
  });

  it('allows abandoning an active ship (Phase 3 playtest fix — no 409)', () => {
    // Regression-lock: the original devPlayerShipsAbandonHandler returned
    // 409 when `isActive && activeRoomId !== null`, which blocked the
    // user from dropping their lingering ship from the galaxy map. The
    // current contract treats the player as the authority over their
    // own roster regardless of active state.
    const ship = store.create({ playerId: 'p1', userId: null, kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
    store.markActive(ship.shipId, 'room-xyz', {
      x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, health: 100, lastFireClientTick: 0,
    });
    expect(store.get(ship.shipId)!.isActive).toBe(true);
    const res = makeRes();
    devPlayerShipsAbandonHandler(
      makeReq({ params: { shipId: ship.shipId }, body: { playerId: 'p1' } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ ok: true, shipId: ship.shipId });
    expect(store.get(ship.shipId)).toBeNull();
  });
});
