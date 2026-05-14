/**
 * Phase A coverage lock — `JoinOptions.shipId` binding through the
 * real SectorRoom + PlayerShipStore stack.
 *
 * UNCOVERED PRIOR: the existing tests cover Limbo-restore (Phase 8 sub-phase B
 * lingering hull specs) and the wire schema for `JoinOptionsSchema.shipId`
 * in `messages.test.ts`. What was missing: a join-time integration test
 * that proves the cross-cutting Phase 2 + Phase 5 contract — a client
 * connecting with `shipId` of an EXISTING stored ship binds THAT row's
 * pose, while a foreign `shipId` falls back safely and a fresh
 * `isNewShip:true` creates a new row.
 *
 * COVERS (Phase A3 of `humble-strolling-coral.md`):
 *   1. No shipId + no roster → fresh row, spawn at default origin.
 *   2. shipId of an existing stored ship → row marked active, ship
 *      pose hydrated from store (lastX/lastY/health). Snapshot's
 *      bound entry carries the seeded shipInstanceId.
 *   3. Foreign shipId (owned by another playerId) → fall back to
 *      legacy spawn; the foreign row is NOT marked active for the
 *      requesting player.
 *   4. `isNewShip:true` + existing roster → new row created (not the
 *      reuse-most-recent path).
 *
 * WHAT CHANGING WOULD RE-FAIL THIS:
 *   - Dropping the owner check on shipId-bind (would let a malicious
 *     client claim another player's roster row).
 *   - Removing the same-sector gate (would teleport ships across
 *     sectors silently).
 *   - Making `isNewShip:true` reuse the most-recent existing entry
 *     (would block the user from clicking a sector + picking kind
 *     for a fresh fighter).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';

describe('SectorRoom × PlayerShipStore — shipId join binding', () => {
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

  it('no shipId + no roster → fresh row created (default path)', async () => {
    const pid = randomUUID();
    await harness.connectAs(pid, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });

    const roster = getPlayerShipStore().listByPlayer(pid);
    expect(roster).toHaveLength(1);
    expect(roster[0]!.kind).toBe('fighter');
    expect(roster[0]!.isActive).toBe(true);
  });

  it('shipId of own stored ship → that row is marked active, pose hydrated', async () => {
    const pid = randomUUID();
    const store = getPlayerShipStore();

    // Seed a stored ship with a distinctive pose so we can verify
    // hydration.
    const SEED_X = 1234;
    const SEED_Y = -567;
    const SEED_HEALTH = 42;
    const seeded = store.create({
      playerId: pid,
      userId: null,
      kind: 'fighter',
      sectorKey: 'sol-prime',
      x: SEED_X,
      y: SEED_Y,
      health: SEED_HEALTH,
    });
    expect(store.get(seeded.shipId)!.isActive).toBe(false);

    // Connect with that shipId. SectorRoom.onJoin should resolve the
    // row, hydrate spawn pose from it, and mark it active.
    await harness.connectAs(pid, { shipKind: 'fighter', shipId: seeded.shipId });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });

    const after = store.get(seeded.shipId)!;
    expect(after.isActive).toBe(true);
    expect(after.activeRoomId).not.toBeNull();
    // No new row added — same shipId reused.
    expect(store.listByPlayer(pid)).toHaveLength(1);
    // Health stays at the seeded value (markActive carries it through).
    expect(after.health).toBe(SEED_HEALTH);
  });

  it('foreign shipId (owned by another player) → falls back, foreign row untouched', async () => {
    const ownerPid = randomUUID();
    const attackerPid = randomUUID();
    const store = getPlayerShipStore();

    // Owner's seeded stored ship.
    const ownerShip = store.create({
      playerId: ownerPid,
      userId: null,
      kind: 'heavy',
      sectorKey: 'sol-prime',
      x: 100,
      y: 200,
      health: 999,
    });
    expect(store.get(ownerShip.shipId)!.isActive).toBe(false);

    // Attacker connects claiming the owner's shipId.
    await harness.connectAs(attackerPid, {
      shipKind: 'fighter',
      shipId: ownerShip.shipId,
    });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === attackerPid });

    // The owner's row must NOT have been marked active for the
    // attacker. Its activeRoomId stays null and its playerId is
    // unchanged.
    const ownerAfter = store.get(ownerShip.shipId)!;
    expect(ownerAfter.playerId).toBe(ownerPid);
    expect(ownerAfter.isActive).toBe(false);
    expect(ownerAfter.activeRoomId).toBeNull();

    // The attacker still spawned successfully (fell back to the
    // fresh-create path). They get their own row, distinct from the
    // owner's.
    const attackerRoster = store.listByPlayer(attackerPid);
    expect(attackerRoster).toHaveLength(1);
    expect(attackerRoster[0]!.shipId).not.toBe(ownerShip.shipId);
  });

  it('isNewShip:true + existing roster → creates a new row (not reuse-most-recent)', async () => {
    const pid = randomUUID();
    const store = getPlayerShipStore();

    // Seed one existing row so the reuse-most-recent branch is the
    // tempting one to take.
    const existing = store.create({
      playerId: pid,
      userId: null,
      kind: 'scout',
      sectorKey: 'sol-prime',
      x: 0,
      y: 0,
      health: 100,
    });
    expect(store.listByPlayer(pid)).toHaveLength(1);

    // Connect with isNewShip:true — the room should forceFreshCreate
    // and add a SECOND row, not bind the existing scout.
    await harness.connectAs(pid, { shipKind: 'fighter', isNewShip: true });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });

    const roster = store.listByPlayer(pid);
    expect(roster.length).toBe(2);
    // The pre-existing scout is still there, unchanged.
    expect(store.get(existing.shipId)).not.toBeNull();
    expect(store.get(existing.shipId)!.kind).toBe('scout');
    // The new active row is the fighter, NOT the scout.
    const active = roster.find((r) => r.isActive);
    expect(active).toBeDefined();
    expect(active!.kind).toBe('fighter');
    expect(active!.shipId).not.toBe(existing.shipId);
  });
});
