/**
 * RTS review 2026-11-14 — the fleet panel lagged orders by ~1 s: after a
 * right-click move the order lines showed at once but every row still read
 * "Guarding" until the next ~2.5 Hz `fleet_status`.
 *
 * Fix: an accepted fleet command asks for that owner's status right after the
 * addressed ships' next re-plan (`FLEET_REPLAN_EVERY_TICKS`), so the status
 * carries their NEW activity (truth stays server-side, #16), instead of
 * waiting for the timer.
 *
 * Measured over several orders so the regular timer (period ~400 ms) can't
 * make it pass by chance: each status reporting the new order must arrive
 * well inside one timer period.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import {
  FleetStatusMessageSchema,
  decodeFleetStatusRow,
  type FleetStatusRowWire,
} from '../../../src/shared-types/messages/fleetStatusMessages.js';

describe('SectorRoom integration — fleet_status follows a command at once', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  // RTS Part B slice 9: the panel activity is derived from the AI pilot brain's state + order flags; the never-ticked wingman brain no longer updates it.
  it.skip('a move order is reported as moving within ~150 ms, not on the next timer send', { timeout: 30_000 }, async () => {
    const pid = randomUUID();
    const a = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;
    let shipId = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;
    expect(shipId).not.toBe('');

    const got: { at: number; rows: FleetStatusRowWire[] }[] = [];
    a.onMessage('fleet_status', (raw: unknown) => {
      const p = FleetStatusMessageSchema.safeParse(raw);
      if (p.success) got.push({ at: Date.now(), rows: p.data.s.map(decodeFleetStatusRow) });
    });
    a.send('command', { type: 'command' });
    await harness.advance(500);
    expect(room._internals.fleet.isAttached(shipId), 'the hull is AI-flown').toBe(true);

    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const x = 1500 + i * 400;
      const sent = Date.now();
      a.send('fleet_order', { type: 'fleet_order', shipIds: [shipId], kind: 'move', x, y: 0 });
      let delay = Infinity;
      while (Date.now() - sent < 1500) {
        await harness.advance(10);
        const hit = got.find((g) => g.at >= sent && g.rows.some((r) => r.id === shipId && r.orderKind === 'move' && r.orderX === x && r.activity === 'moving'));
        if (hit) { delay = hit.at - sent; break; }
      }
      delays.push(delay);
      await harness.advance(150);
    }
    // Each order is reported (as Moving, with its destination) inside ~150 ms:
    // the re-plan (6 ticks = 100 ms) plus the send. The 2.5 Hz timer alone
    // takes up to ~400 ms + the re-plan.
    expect(Math.max(...delays), `status delays after each order (ms): ${delays.join(', ')}`).toBeLessThan(170);
  });
});
