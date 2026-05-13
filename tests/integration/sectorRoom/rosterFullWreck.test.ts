/**
 * User report 2026-05-13 (server log from session ending in crash):
 *
 *   [20:05:13.285] WARN  Roster full — ship spawned without a roster row
 *   [20:05:13.303] INFO  ship abandoned → wreck   ← 18ms later
 *
 * The user reconnected with `isNewShip:true` while their roster was
 * already at the 10-ship cap. `bindRosterEntry` correctly refused to
 * create an 11th roster row (RosterFullError caught, returns ''),
 * but the FALLBACK at `SectorRoom.ts` line 2330-2332 — meant for
 * engineering rooms (sectorKey === null) — fires for ANY ship with
 * an empty `shipInstanceId`, including galaxy-room ships whose
 * roster was full. The ship gets a synthetic UUID, then the
 * 30-tick abandon-detection sweep observes
 * `store.get(syntheticUUID) === null` (because no roster row),
 * marks the ship "abandoned", and converts it to a wreck — 18ms
 * after spawn.
 *
 * The user then can't play because their new ship is a wreck.
 * Drones swarm the wreck, physics blows up, server gets clamp-
 * spammed, client lag goes to 660ms RTT, phone almost crashes.
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

describe('SectorRoom integration — roster-full fresh-spawn does not produce a wreck', () => {
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

  it('FAILS today: full roster + isNewShip:true → server creates a wreck within ~500ms', async () => {
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
    // RosterFullError and return ''. The synthetic-UUID fallback fires
    // unconditionally → ship gets a UUID with NO roster row → 30-tick
    // abandon-sweep converts it to a wreck.
    await harness.connectAs(PID, { isNewShip: true, shipKind: 'fighter' });

    // Wait for the abandon-detection sweep to fire. It runs every 30
    // ticks (~500ms). Use the event-driven wait so we fail fast on
    // ANY wreck-conversion (good outcome: timeout fires, no wreck).
    let wreckEventSeen = false;
    try {
      await harness.events.waitFor(
        { tag: 'ship_abandoned', where: (d) => d['playerId'] === PID },
        { timeoutMs: 1500 },
      );
      wreckEventSeen = true;
    } catch {
      // timeout — no wreck event was logged, which is the FIXED state.
    }

    const room = harness.getServerRoom()!;
    const wreckCount = (room.state as unknown as { wrecks: { size: number } }).wrecks.size;

    // FIX EXPECTATION: a fresh-spawn into a full roster on a galaxy
    // room MUST NOT produce a wreck. Either the spawn is rejected
    // cleanly (state.ships unchanged) or it succeeds with proper
    // roster bookkeeping. The current bug produces a wreck in
    // state.wrecks within ~500ms.
    expect(
      wreckCount,
      `Roster-full spawn produced ${wreckCount} wreck(s) in the sector. ` +
        `Expected 0 — the spawn should either be rejected or accommodated, ` +
        `never produce a ghost ship that gets immediately converted to a wreck. ` +
        `Bug origin: SectorRoom.ts:2330 synthetic-UUID fallback fires for ` +
        `galaxy rooms when the roster is full; the 30-tick abandon sweep then ` +
        `sees a shipInstanceId with no roster row and reaps it.`,
    ).toBe(0);
    expect(wreckEventSeen, 'no ship_abandoned event should fire for this playerId').toBe(false);
  });
});
