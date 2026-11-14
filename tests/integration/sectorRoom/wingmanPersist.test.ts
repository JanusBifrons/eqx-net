/**
 * RTS slice 9 — a player's AI-flown ships keep their standing job across a
 * server restart: patrol mode + route, aggressive stance and a 2-ship squad
 * (leader, shape) survive; a direct order does not.
 *
 * Two-boot shape (like `livingWorldDirectorPersistence.test.ts`): boot #1 is a
 * real room whose parked hulls are given their jobs through the owner-checked
 * fleet API; its teardown writes the sector snapshot (the real
 * `lingeringHullsForSnapshot` + `SectorPersistence.persist`, captured from the
 * persistence sink). Boot #2 is a FRESH room + fleet; the captured row is
 * hydrated through a real `SectorPersistence.hydrate` wired to the room's own
 * restore paths (`restoreLingeringHulls` → brains attached + restoreShip, then
 * the squads). The roster rows carry over like the DB would carry them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import type { PlayerShipRecord } from '../../../src/server/playerShips/PlayerShipStore.js';
import { SectorPersistence } from '../../../src/server/rooms/SectorPersistence.js';
import type { SectorSnapshotLingeringHull, SectorSnapshotPayload } from '../../../src/server/rooms/SectorSnapshot.js';

const SECTOR = 'sol-prime';
const noopLogger = { info: () => undefined, warn: () => undefined } as unknown as Logger;
const ROUTE: Array<[number, number]> = [[400, 0], [400, 600], [-300, 600]];

function hullRow(shipId: string, playerId: string, x: number, y: number): SectorSnapshotLingeringHull {
  return { shipInstanceId: shipId, playerId, kind: 'fighter', x, y, vx: 0, vy: 0, angle: 0, angvel: 0, health: 400, shieldDown: false };
}

describe('SectorRoom integration — wingman state survives a restart (RTS slice 9)', () => {
  let h: SectorTestHarness | undefined;
  afterEach(async () => {
    if (h) await h.cleanup();
    h = undefined;
  }, 10_000);

  it('patrol + route + aggressive stance and a 2-ship squad come back after a two-boot restart', async () => {
    const PILOT = randomUUID();
    const OWNER = randomUUID();

    // ── Boot #1 ──────────────────────────────────────────────────────────
    h = await bootSectorTestServer({ sectorKey: SECTOR, droneCount: 0, testMode: true });
    await h.connectActive(PILOT, { shipKind: 'fighter' });
    await h.advance(150);
    let room = h.getServerRoom() as unknown as SectorRoom;
    const store = getPlayerShipStore();
    const mk = (x: number, y: number): PlayerShipRecord =>
      store.create({ playerId: OWNER, userId: null, kind: 'fighter', sectorKey: SECTOR, x, y, health: 400 });
    const patroller = mk(-800, 300);
    const lead = mk(900, -200);
    const wing = mk(950, -150);
    room._internals.restoreLingeringHulls([
      hullRow(patroller.shipId, OWNER, -800, 300),
      hullRow(lead.shipId, OWNER, 900, -200),
      hullRow(wing.shipId, OWNER, 950, -150),
    ]);
    let fleet = room._internals.fleet;
    expect(fleet.setMode(OWNER, [patroller.shipId], 'patrol', { route: ROUTE })).toEqual([patroller.shipId]);
    expect(fleet.setStance(OWNER, [patroller.shipId], 'aggressive')).toEqual([patroller.shipId]);
    const formed = fleet.formSquad(OWNER, [lead.shipId, wing.shipId], 'column');
    expect(formed).not.toBeNull();
    fleet.applyOrder(OWNER, [lead.shipId, wing.shipId], { kind: 'move', x: 2000, y: 2000 }); // never persisted
    await h.advance(150);

    // Teardown writes the sector snapshot (onDispose) — the "shutdown" save.
    const sink = h.sink;
    const rosterRows = [patroller, lead, wing].map((r) => ({ ...store.get(r.shipId)! }));
    await h.cleanup();
    h = undefined;
    const snaps = sink.ops.filter(
      (o): o is Extract<typeof o, { type: 'SNAPSHOT' }> => o.type === 'SNAPSHOT' && o.sectorId === SECTOR,
    );
    expect(snaps.length).toBeGreaterThan(0);
    const saved = snaps[snaps.length - 1]!;
    const payload = JSON.parse(saved.payloadJson) as SectorSnapshotPayload;
    expect(payload.lingeringHulls?.find((r) => r.shipInstanceId === patroller.shipId))
      .toMatchObject({ mode: 'patrol', stance: 'aggressive' });
    expect(payload.squads).toHaveLength(1);

    // ── Boot #2: fresh room, fresh fleet ─────────────────────────────────
    h = await bootSectorTestServer({ sectorKey: SECTOR, droneCount: 0, testMode: true });
    await h.connectActive(PILOT, { shipKind: 'fighter' });
    await h.advance(150);
    room = h.getServerRoom() as unknown as SectorRoom;
    fleet = room._internals.fleet;
    for (const r of rosterRows) getPlayerShipStore().put(r as PlayerShipRecord);
    expect(fleet.isAttached(patroller.shipId)).toBe(false);

    const internals = room._internals;
    new SectorPersistence({
      sectorKey: () => SECTOR,
      sabF32: new Float32Array(0),
      swarmRegistry: { all: () => [], has: () => false },
      swarmHealth: new Map(),
      structures: () => [],
      restoreStructures: () => undefined,
      scrapEntities: () => [],
      restoreScrap: () => undefined,
      lingeringHulls: () => [],
      restoreLingeringHulls: (rows) => internals.restoreLingeringHulls(rows),
      restoreFleetSquads: (rows) => { internals.fleet.restoreSquads(rows); },
      saveRow: () => undefined,
      loadRow: () => ({ snapshot: saved.payloadJson, created_at: Date.now() }),
      logger: noopLogger,
    } as ConstructorParameters<typeof SectorPersistence>[0]).hydrate();

    const p = fleet.brainOf(patroller.shipId)!;
    expect(p, 'the patroller is AI-flown again').toBeTruthy();
    expect(p.mode).toBe('patrol');
    expect(p.stance).toBe('aggressive');
    expect(p.patrolRouteLength).toBe(3);
    expect([p.patrolRouteX(2), p.patrolRouteY(2)]).toEqual([-300, 600]);

    const sq = fleet.squadOf(wing.shipId)!;
    expect(sq).not.toBeNull();
    expect(sq).toMatchObject({ ownerId: OWNER, leaderId: lead.shipId, shape: 'column' });
    expect([...sq.memberIds].sort()).toEqual([lead.shipId, wing.shipId].sort());
    expect(fleet.brainOf(lead.shipId)!.order, 'direct orders are not persisted').toBeNull();

    // The restored squad flies: the member takes its slot on the leader.
    await h.advance(200);
    expect(fleet.brainOf(wing.shipId)!.formationLeaderId).toBe(lead.shipId);
    expect(fleet.statusFor(OWNER).find((s) => s.id === wing.shipId)?.squadLeaderId).toBe(lead.shipId);
  }, 30_000);
});
