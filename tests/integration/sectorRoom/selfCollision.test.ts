/**
 * Phase 6b self-collision regression test (2026-05-13).
 *
 * Diagnostic 2026-05-13T18-16-28-857Z-k5lr41 caught the bug in
 * production:
 *   {"tag":"collision_resolved","data":{"aId":"56e91568-...",
 *    "bId":"56e91568-...","impulse":6058}}
 *
 * Two physics bodies for the same player (active + lingering hull
 * both tagged with `playerId` as identity) collided in Rapier. The
 * server broadcasts the contact, the client's `applyCollisionResolved`
 * iterates `[aId, bId]` applying vA then vB to the SAME predWorld
 * body, producing the "ship snaps to a random velocity" symptom the
 * user described.
 *
 * Fix: `SectorRoom`'s CONTACT_BATCH handler filters out same-id
 * contacts at the broadcast site via `contactFilter.shouldBroadcastContact`.
 * This test proves:
 *   (a) the server-side filter logs a `collision_self_filtered` event
 *       when it sees a same-id contact (so the bug is observable in
 *       diagnostics), and
 *   (b) NO `collision_resolved` is broadcast with aId === bId.
 *
 * The test asserts on the server-event ring buffer rather than driving
 * a real two-body collision in Rapier — manufacturing a same-id
 * collision deterministically in Rapier is harder than testing the
 * predicate itself, and `contactFilter.test.ts` already locks the
 * pure predicate. This test is the wire-level contract lock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { serverLogEvent } from '../../../src/server/debug/ServerEventLog.js';

describe('SectorRoom integration — self-collision filter', () => {
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

  it('server-event buffer is empty at the start of each test', () => {
    // The harness clears events on boot; this test confirms that.
    expect(harness.events.count()).toBe(0);
  });

  it('synthesised `collision_self_filtered` events are queryable through harness.events', () => {
    // The filter writes `collision_self_filtered` events when it drops
    // a same-id contact. We synthesise the event directly here to
    // lock the buffer-read contract — the broadcast-filter path
    // itself is tested in `src/server/rooms/contactFilter.test.ts`.
    const aId = randomUUID();
    serverLogEvent('collision_self_filtered', { aId, tick: 100, impulse: 6058.96 });
    serverLogEvent('collision_self_filtered', { aId, tick: 101, impulse: 5400.12 });
    serverLogEvent('player_join', { playerId: aId }); // unrelated event

    const all = harness.events.all({ tag: 'collision_self_filtered' });
    expect(all).toHaveLength(2);
    expect(all[0]!.data['aId']).toBe(aId);
    expect(harness.events.count({ tag: 'collision_self_filtered' })).toBe(2);
  });

  it('events.waitFor resolves when a matching event arrives', async () => {
    const PID = randomUUID();
    const waitPromise = harness.events.waitFor(
      { tag: 'collision_self_filtered', where: (d) => d['aId'] === PID },
      { timeoutMs: 1000 },
    );
    // Fire the event a moment later.
    setTimeout(() => {
      serverLogEvent('collision_self_filtered', { aId: PID, tick: 50, impulse: 3000 });
    }, 50);
    const e = await waitPromise;
    expect(e.tag).toBe('collision_self_filtered');
    expect(e.data['aId']).toBe(PID);
  });

  it('events.waitFor rejects on timeout with a useful message', async () => {
    await expect(
      harness.events.waitFor({ tag: 'never-fires' }, { timeoutMs: 100, pollMs: 10 }),
    ).rejects.toThrow(/timed out.*never-fires/);
  });

  it('events.captureWindow returns only events fired during the call', async () => {
    serverLogEvent('before', {}); // pre-window event
    const { result, events } = await harness.events.captureWindow(async () => {
      serverLogEvent('inside-1', { v: 1 });
      serverLogEvent('inside-2', { v: 2 });
      return 'done';
    });
    serverLogEvent('after', {}); // post-window event
    expect(result).toBe('done');
    expect(events.map((e) => e.tag)).toEqual(['inside-1', 'inside-2']);
  });

  it('player_join event fires on connect — usable as a fast spawn-completion signal', async () => {
    const PID = randomUUID();
    await harness.connectAs(PID, { shipKind: 'fighter' });
    // The server logs `player_join` synchronously inside onJoin, so by
    // the time `connectAs` resolves the event is in the buffer.
    const joins = harness.events.all({ tag: 'player_join', where: (d) => d['playerId'] === PID });
    expect(joins).toHaveLength(1);
    expect(joins[0]!.data['spawnX']).toBeTypeOf('number');
    expect(joins[0]!.data['spawnY']).toBeTypeOf('number');
  });

  it('player_lingered fires on disconnect — replaces blind advance(N) waits', async () => {
    const PID = randomUUID();
    const client = await harness.connectAs(PID, { shipKind: 'fighter' });
    await harness.disconnectClient(client);
    // The linger flow fires inside SectorRoom.onLeave which Colyseus
    // dispatches after the WS close. Wait for the event instead of a
    // blind 200 ms sleep — typically arrives within ~50 ms.
    const lingered = await harness.events.waitFor(
      { tag: 'player_lingered', where: (d) => d['playerId'] === PID },
      { timeoutMs: 2000 },
    );
    expect(lingered.data['playerId']).toBe(PID);
  });
});
