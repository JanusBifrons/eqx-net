/**
 * User report 2026-05-13 (server log from session ending in crash):
 *
 *   [20:05:13.285] WARN  Roster full — ship spawned without a roster row
 *   [20:05:13.303] INFO  ship abandoned   ← 18ms later
 *
 * The user reconnected with `isNewShip:true` while their roster was
 * already at the 10-ship cap. `bindRosterEntry` correctly refused to
 * create an 11th roster row (RosterFullError caught, returns ''),
 * but the FALLBACK at `SectorRoom.ts` line 2330-2332 — meant for
 * engineering rooms (sectorKey === null) — fires for ANY ship with
 * an empty `shipInstanceId`, including galaxy-room ships whose
 * roster was full. The ship gets a synthetic UUID, then the
 * 30-tick abandon-detection sweep observes
 * `store.get(syntheticUUID) === null` (because no roster row) and
 * marks the ship "abandoned" — 18ms after spawn.
 *
 * The user then can't play because their new ship is reaped out from
 * under them.
 *
 * Per Invariant #13: this failing test goes in BEFORE the fix.
 *
 * Expected behaviour (the fix): when the roster is full and a galaxy
 * room spawn comes in, EITHER reject the spawn cleanly (with a wire-
 * level error the client can show) OR allow it with a real
 * roster-tracked existence — never spawn a ghost ship that gets
 * immediately reaped. The simplest fix is to scope the synthetic-UUID
 * fallback to engineering rooms only (sectorKey === null), so a
 * galaxy-room roster-full spawn returns `shipInstanceId === ''` and
 * the abandon sweep's `=== ''` skip-clause handles it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';

describe('SectorRoom integration — roster-full fresh-spawn is not reaped', () => {
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

  it('full roster + isNewShip:true → server does NOT reap the fresh hull within ~500ms', async () => {
    const PID = randomUUID();

    // Seed the player's roster to the 10-ship cap. PlayerShipStore.create
    // is the same path the spawn flow uses; this primes the store so the
    // 11th spawn hits RosterFullError.
    const store = getPlayerShipStore();
    for (let i = 0; i < 10; i++) {
      store.create({
        playerId: PID,
        userId: null,
        kind: 'fighter',
        sectorKey: 'sol-prime',
        x: i * 10, y: 0,
        health: 500,
      });
    }
    expect(store.listByPlayer(PID)).toHaveLength(10);

    // Now connect with isNewShip:true — bindRosterEntry will catch
    // RosterFullError and return ''. The synthetic-UUID fallback must
    // NOT fire for a galaxy room; if it does, the ship gets a UUID with
    // NO roster row → the 30-tick abandon-sweep reaps it.
    await harness.connectAs(PID, { isNewShip: true, shipKind: 'fighter' });

    // Wait for the abandon-detection sweep to fire. It runs every 30
    // ticks (~500ms). Use the event-driven wait so we fail fast on
    // ANY reap (good outcome: timeout fires, no abandon event).
    let abandonEventSeen = false;
    try {
      await harness.events.waitFor(
        { tag: 'ship_abandoned', where: (d) => d['playerId'] === PID },
        { timeoutMs: 1500 },
      );
      abandonEventSeen = true;
    } catch {
      // timeout — no abandon event was logged, which is the FIXED state.
    }

    // FIX EXPECTATION: a fresh-spawn into a full roster on a galaxy
    // room MUST NOT be reaped. Either the spawn is rejected cleanly
    // (state.ships unchanged) or it succeeds with proper roster
    // bookkeeping. The original bug reaped the ghost ship within ~500ms
    // (it fired `ship_abandoned` for this playerId).
    expect(
      abandonEventSeen,
      'no ship_abandoned event should fire for this playerId — a roster-full ' +
        'galaxy spawn must not be reaped (SectorRoom.ts synthetic-UUID fallback ' +
        'is scoped to engineering rooms; the abandon sweep skips empty shipInstanceIds).',
    ).toBe(false);
  });
});
