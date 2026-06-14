/**
 * Integration coverage for the per-ship warp visual broadcasts.
 *
 * When a ship completes its join handshake (`client_ready`), the server
 * emits `warp_in` to ALL occupants of the sector — INCLUDING the joiner
 * (the unified crispy-kazoo handshake: the joiner needs the broadcast to
 * drop its own warp curtain in sync with the arrival flash everyone else
 * sees). When a ship COMMITS transit OUT of a sector, the server emits
 * `warp_out` to every other occupant (except the leaver). Each carries
 * `{ type, playerId, x, y, arrivalTick? }`; the client renderer fires a
 * one-shot flash + burst ripple at the world point.
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

  it('emits warp_in to ALL occupants (including the joiner) on the join handshake', async () => {
    const pidA = randomUUID();
    const pidB = randomUUID();

    // A is an already-present, fully-activated occupant.
    const roomA = await harness.connectActive(pidA, { shipKind: 'fighter' });

    // Subscribe to warp_in BEFORE the second player joins so we don't
    // miss the broadcast.
    const aReceivedWarpIn: WarpInEvent[] = [];
    roomA.onMessage('warp_in', (msg: WarpInEvent) => {
      aReceivedWarpIn.push(msg);
    });

    // B connects; we drive its handshake manually so we can subscribe to
    // warp_in BEFORE `client_ready` triggers the broadcast (the joiner
    // receives its OWN warp_in under the unified handshake).
    const roomB = await harness.connectAs(pidB, { shipKind: 'fighter' });
    const bReceivedWarpIn: WarpInEvent[] = [];
    roomB.onMessage('warp_in', (msg: WarpInEvent) => {
      bReceivedWarpIn.push(msg);
    });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pidB });

    // Complete B's handshake → server broadcasts warp_in to ALL occupants.
    roomB.send('client_ready', { type: 'client_ready' });

    // Allow the broadcast to round-trip.
    await harness.advance(200);

    // The existing occupant (A) sees B's arrival.
    const aEvt = aReceivedWarpIn.find((m) => m.playerId === pidB);
    expect(aEvt, 'A must receive warp_in for B').toBeDefined();
    expect(aEvt!.type).toBe('warp_in');
    expect(typeof aEvt!.x).toBe('number');
    expect(typeof aEvt!.y).toBe('number');

    // The joiner (B) ALSO receives its own warp_in — the unified
    // handshake broadcasts to ALL with `arrivalTick` so the curtain drop
    // + warp-in flash fire in sync everywhere (no `except: client`).
    const bEvt = bReceivedWarpIn.find((m) => m.playerId === pidB);
    expect(bEvt, 'the joiner B must receive its own warp_in').toBeDefined();
    expect(bEvt!.type).toBe('warp_in');
  }, 20_000);

  /**
   * NOT COVERED here: the full warp_out wire path. `commitTransit` fires
   * the warp_out broadcast only AFTER `matchMaker.reserveSeatFor` resolves,
   * and that needs a live destination room (`galaxy-cygnus-arm`). The
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
