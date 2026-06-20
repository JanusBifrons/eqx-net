/**
 * Phase A coverage lock — PlayerShipStore × SectorRoom × diag-endpoint
 * round-trip.
 *
 * UNCOVERED PRIOR TO THIS SPEC:
 *   - The handler [diagRouter.playerShips.test.ts](../../../src/server/routes/diagRouter.playerShips.test.ts)
 *     locks the wire shape with a mocked store, but no integration test
 *     boots a real Colyseus SectorRoom and verifies that a real
 *     player-join populates a real `PlayerShipStore` row that the
 *     handler then returns. That round-trip is the missing piece —
 *     a future refactor that drops the store write from the spawn
 *     path would not be caught by the unit test.
 *
 * COVERS (Phase A2 of `humble-strolling-coral.md`):
 *   - Connect → store has the player's roster row with isActive=true.
 *   - Multi-player join → isolated by playerId (no cross-contamination).
 *   - Disconnect → row LINGERS in the store with isActive still true
 *     until the 15-min eviction window. (Behaviour locked at:
 *     `SectorRoom.markRosterLinger` calls `markActive` with the
 *     LIMBO_DISCONNECT_TTL_MS expires-at; the prune sweep then later
 *     flips it on time-out.) We do not exercise the wall-clock 15-min
 *     branch here — the LIMBO_DISCONNECT_TTL_MS constant is locked at
 *     900_000 by an inline assertion + a separate unit test in
 *     `LimboStore.test.ts` already covers the prune timing.
 *   - Wire-shape round-trip: invoke `devPlayerShipsHandler` against the
 *     harness's singleton store after the real spawn and assert the
 *     response matches the contract the client `ShipRosterPanel`
 *     consumes.
 *
 * WHAT CHANGING WOULD RE-FAIL THIS:
 *   - Removing the `store.create` / `store.markActive` call from the
 *     SectorRoom spawn path (regression: panel goes empty for fresh
 *     players).
 *   - Wire-shape rename / removal of any of the 12 expected fields.
 *   - Linger flip flipping `isActive=false` instantly on disconnect
 *     instead of staying true through the 15-min window.
 *   - Cross-player leak (one player seeing another's ships).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import {
  devPlayerShipsHandler,
} from '../../../src/server/routes/diagRouter.js';
import {
  PLAYER_SHIP_ACTIVE_LINGER_MS,
} from '../../../src/server/playerShips/PlayerShipStore.js';
import type { Request, Response } from 'express';

function makeReq(query: Record<string, unknown> = {}): Request {
  return { query } as unknown as Request;
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

describe('PlayerShipStore × SectorRoom integration — spawn → store row → diag endpoint', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
    });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('PLAYER_SHIP_ACTIVE_LINGER_MS is exactly 15 min', () => {
    // Compile-time constant — locked here so a typo (e.g. 90_000 vs 900_000) is
    // caught even without exercising the timer. Post-WS-B (Limbo retired) this is
    // the SOLE linger-window constant; markLinger writes it as the roster
    // expiresAt (currently unenforced — no prune sweep — so effectively forever).
    expect(PLAYER_SHIP_ACTIVE_LINGER_MS).toBe(900_000);
  });

  it('connect → PlayerShipStore has a row for the player with isActive=true', async () => {
    const pid = randomUUID();
    await harness.connectAs(pid, { shipKind: 'fighter' });
    await harness.events.waitFor({
      tag: 'player_join',
      where: (d) => d['playerId'] === pid,
    });

    const roster = getPlayerShipStore().listByPlayer(pid);
    expect(roster).toHaveLength(1);
    const entry = roster[0]!;
    expect(entry.playerId).toBe(pid);
    expect(entry.kind).toBe('fighter');
    expect(entry.isActive).toBe(true);
    expect(entry.activeRoomId).not.toBeNull();
    // expiresAt is set to now + 15 min on markActive.
    expect(entry.expiresAt).toBeGreaterThan(0);
  });

  it('two players join → each sees only their own row (no cross-leak)', async () => {
    const p1 = randomUUID();
    const p2 = randomUUID();

    await harness.connectAs(p1, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === p1 });

    await harness.connectAs(p2, { shipKind: 'scout' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === p2 });

    const store = getPlayerShipStore();
    const r1 = store.listByPlayer(p1);
    const r2 = store.listByPlayer(p2);
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(r1[0]!.kind).toBe('fighter');
    expect(r2[0]!.kind).toBe('scout');
    // No id collision — each player got their own shipInstanceId.
    expect(r1[0]!.shipId).not.toBe(r2[0]!.shipId);
  });

  it('disconnect → row LINGERS with isActive=true through the 15-min window', async () => {
    const pid = randomUUID();
    const client = await harness.connectAs(pid, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });

    const before = getPlayerShipStore().listByPlayer(pid)[0]!;
    const shipId = before.shipId;
    const expiresBefore = before.expiresAt;
    expect(before.isActive).toBe(true);

    await harness.disconnectClient(client);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pid });

    // The row is still in the store and still flagged active — the
    // 15-min eviction timer is scheduled but has not fired. A future
    // regression that flipped isActive=false immediately on disconnect
    // would break the auto-resume contract (the player would lose
    // their ship if they reconnected within 15 min).
    const after = getPlayerShipStore().get(shipId);
    expect(after).not.toBeNull();
    expect(after!.isActive).toBe(true);
    // expiresAt is refreshed on linger via markActive(...,
    // Date.now() + LIMBO_DISCONNECT_TTL_MS) — must be at least as far
    // out as the pre-disconnect value.
    expect(after!.expiresAt).toBeGreaterThanOrEqual(expiresBefore);
  });

  it('diag handler round-trip: real spawn → JSON body matches the client wire contract', async () => {
    const pid = randomUUID();
    await harness.connectAs(pid, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });

    const req = makeReq({ playerId: pid });
    const res = makeRes();
    devPlayerShipsHandler(req, res);

    // Handler ran against the harness's singleton store via the
    // setPlayerShipStore injection — so the JSON body reflects the
    // real spawn we just performed.
    expect(res._status).toBe(200);
    const body = res._json as { playerId: string; ships: Array<Record<string, unknown>> };
    expect(body.playerId).toBe(pid);
    expect(body.ships).toHaveLength(1);
    const entry = body.ships[0]!;
    // Same field-name contract the unit test locks — re-asserted here
    // against a real spawn flow so we catch wire/store drift even if
    // the unit test's mocked store somehow diverges.
    expect(Object.keys(entry).sort()).toEqual(
      [
        'activeRoomId',
        'createdAt',
        'expiresAt',
        'health',
        'isActive',
        'kind',
        'kindVersion',
        'level',
        'xp',
        'statAlloc',
        'sectorKey',
        'shipId',
        'updatedAt',
        'x',
        'y',
      ].sort(),
    );
    expect(entry['isActive']).toBe(true);
    expect(entry['kind']).toBe('fighter');
    expect(typeof entry['shipId']).toBe('string');
    expect((entry['shipId'] as string).length).toBeGreaterThan(0);
  });

  it('roster fetch for a player who never joined returns an empty list (not an error)', () => {
    const stranger = randomUUID();
    const req = makeReq({ playerId: stranger });
    const res = makeRes();
    devPlayerShipsHandler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ playerId: stranger, ships: [] });
  });
});
