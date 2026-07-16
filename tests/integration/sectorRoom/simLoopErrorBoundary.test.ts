/**
 * Campaign PR 1.1 (anti-patterns review 2026-07, C-server 1 / Part D #15):
 * the authoritative sim loop must SURVIVE a throwing subsystem.
 *
 * Failing-first (invariant #13): before the guardedLoop fix, `SectorRoom`'s
 * setImmediate loop calls `this.update()` bare — one throw anywhere inside a
 * subsystem escapes the callback, the tail `setImmediate(loop)` never runs,
 * and the room's main-thread orchestration is DEAD (in production, the
 * uncaught exception kills the single-process host: every galaxy sector +
 * the director in one shot). Reproduction: poison exactly ONE `update()`
 * call and assert the loop keeps invoking `update()` afterwards. On
 * pre-fix code the loop stops (callsAfterPoison stays 0) and vitest also
 * reports the escaped exception.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

function getRoomById(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

describe('SectorRoom integration — sim-loop error boundary (campaign 1.1)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('one throwing update() does not stop the sim loop', async () => {
    const p1 = randomUUID();
    const cr = await harness.connectActive(p1, {});
    const room = getRoomById(cr.roomId);

    // Poison exactly ONE update() call, then count how many more the loop
    // makes. The wrapper preserves the real update so the room simulates
    // normally after the injected failure.
    const target = room as unknown as { update: () => void };
    const realUpdate = target.update.bind(room);
    let poisonArmed = true;
    let callsAfterPoison = 0;
    target.update = () => {
      if (poisonArmed) {
        poisonArmed = false;
        throw new Error('injected subsystem failure (campaign 1.1 error-boundary lock)');
      }
      callsAfterPoison++;
      realUpdate();
    };

    await vi.waitFor(
      () => {
        expect(callsAfterPoison).toBeGreaterThan(5);
      },
      { timeout: 3_000, interval: 50 },
    );
  });
});
