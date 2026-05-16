/**
 * Integration coverage for the per-ship warp visual broadcasts.
 *
 * When a ship JOINS a sector, the server emits `warp_in` to every
 * existing occupant (except the joiner). When a ship COMMITS transit
 * OUT of a sector, the server emits `warp_out` to every other occupant
 * (except the leaver). Each carries `{ type, playerId, x, y }`; the
 * client renderer fires a one-shot flash + burst ripple at the world
 * point.
 *
 * Why integration: the broadcast originates in SectorRoom and travels
 * over a real Colyseus WebSocket transport. A pure-unit test of the
 * SectorRoom code wouldn't catch a regression where the broadcast is
 * marshalled correctly server-side but the wire serialisation drops
 * the payload (the kind of bug that hides in mocks).
 *
 * See `tests/integration/sectorRoom/harness.ts` for the test-server
 * bring-up and `src/server/transit/TransitOrchestrator.test.ts` for
 * the unit-level coverage of the `warp_out` emission path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { WarpInEvent, WarpOutEvent } from '../../../src/shared-types/messages.js';

describe('SectorRoom — warp visual broadcasts', () => {
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

  it('emits warp_in to existing occupants when a new player joins (excluding the joiner)', async () => {
    const pidA = randomUUID();
    const pidB = randomUUID();

    const roomA = await harness.connectAs(pidA, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pidA });

    // Subscribe to warp_in BEFORE the second player joins so we don't
    // miss the broadcast. Capture into an array — the assertion below
    // just looks at the first one.
    const aReceivedWarpIn: WarpInEvent[] = [];
    roomA.onMessage('warp_in', (msg: WarpInEvent) => {
      aReceivedWarpIn.push(msg);
    });

    // Also subscribe on B's side to verify the joiner does NOT receive
    // their own warp_in event (server filters with `except: client`).
    const bReceivedWarpIn: WarpInEvent[] = [];
    const roomB = await harness.connectAs(pidB, { shipKind: 'fighter' });
    roomB.onMessage('warp_in', (msg: WarpInEvent) => {
      bReceivedWarpIn.push(msg);
    });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pidB });

    // Allow the broadcast to round-trip.
    await harness.advance(150);

    expect(aReceivedWarpIn).toHaveLength(1);
    const evt = aReceivedWarpIn[0]!;
    expect(evt.type).toBe('warp_in');
    expect(evt.playerId).toBe(pidB);
    expect(typeof evt.x).toBe('number');
    expect(typeof evt.y).toBe('number');

    // The joiner themselves must not see a warp_in for their own
    // arrival — their local-arrival visual is driven by the welcome /
    // snapshot machinery, not by this broadcast.
    expect(bReceivedWarpIn).toHaveLength(0);
  }, 20_000);

  /**
   * NOT COVERED here: the full warp_out wire path. `commitTransit` fires
   * the warp_out broadcast only AFTER `matchMaker.reserveSeatFor` resolves,
   * and that needs a live destination room (`galaxy-orion-belt`). The
   * single-room harness used here doesn't define neighbour rooms, so
   * the reservation rejects and commitTransit takes the
   * `destination_unavailable` path before reaching the broadcast.
   *
   * The same architectural seam blocks `transitShipIdBinding.test.ts`
   * from covering full commit (see its preamble). Unit-level coverage
   * of the warp_out emission shape lives in
   * `src/server/transit/TransitOrchestrator.test.ts` under the
   * `commit` describe — three cases:
   *   - emits warp_out at SAB pose, excludes the leaver
   *   - uses SAB pose not the arrival override
   *   - skips warp_out when reservation fails
   *
   * Adding multi-room integration coverage is tracked for the next
   * harness extension; the unit + warp_in-integration combo
   * regression-locks the wire format + the gating contract today.
   */
  // (`WarpOutEvent` import is still needed if/when this layer is added.)
  void ({} as WarpOutEvent);
});
