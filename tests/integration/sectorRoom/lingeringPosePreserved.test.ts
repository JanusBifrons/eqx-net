/**
 * Regression: lingering hull's broadcast pose was (0, 0) right after
 * fresh-spawn-displaces (2026-05-13 smoke-test bug, diag
 * 2026-05-13T20-04-04-888Z-kliu0r).
 *
 * USER REPORTED:
 *   "the abandoned ship moved to zero zero for some reason. It
 *   wasn't on the same place."
 *
 * Distinct from the push-fix test in this directory:
 *   - `lingeringHullPush.test.ts` asserts the hull MOVES under
 *     server-authoritative collision. (Spawn at origin → test still
 *     passes because hull moves from origin.)
 *   - This test asserts the hull's POSE IS PRESERVED across the
 *     disconnect → fresh-spawn-displaces transition. Spawn at a
 *     non-origin point so a (0, 0) regression is detected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';

const PID = randomUUID();
const ABANDON_X = 250;
const ABANDON_Y = -180;

describe('SectorRoom integration — lingering hull pose preserved across fresh-spawn-displaces', () => {
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

  it('lingering hull stays at abandon pose, not (0, 0) or fresh-spawn pose', async () => {
    // Spawn at a clearly non-origin point so a (0, 0) regression is
    // obvious in the assertion failure.
    const client1 = await harness.connectAs(PID, {
      spawnX: ABANDON_X,
      spawnY: ABANDON_Y,
      shipKind: 'fighter',
    });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === PID });

    // Let the worker step physics a few times so SAB reflects the
    // spawn position. The body has zero velocity at spawn so the pose
    // stays at (ABANDON_X, ABANDON_Y) modulo float noise.
    await harness.advance(200);

    const state = harness.getServerRoom()!.state as SectorState;
    const [originalShipId] = [...state.ships.entries()][0]!;

    // Disconnect (linger). The body in the worker stays alive at the
    // abandon pose; it should not teleport.
    await harness.disconnectClient(client1);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === PID });

    // Fresh-spawn-displaces. The new active ship spawns at a different
    // position. The lingering hull's slot moves to `lingeringSlots`
    // and the worker's body is REKEY'd to `linger-${shipInstanceId}`.
    // CRITICAL: the body's pose must NOT be reset by the rekey.
    const FRESH_X = 50;
    const FRESH_Y = 50;
    const lingeringPoses: Array<{ x: number; y: number; isActive: boolean }> = [];
    const client2 = await harness.connectAs(PID, {
      isNewShip: true,
      shipKind: 'fighter',
      spawnX: FRESH_X,
      spawnY: FRESH_Y,
    });
    client2.onMessage('snapshot', (snap: unknown) => {
      const s = snap as SnapshotMessage;
      for (const [, entry] of Object.entries(s.states)) {
        lingeringPoses.push({ x: entry.x, y: entry.y, isActive: entry.isActive });
      }
    });

    // Wake the broadcast loop (idle suppression would skip broadcasts
    // for a stationary new ship that hasn't touched input yet).
    harness.sendThrust(client2);
    await harness.advance(300);

    expect(state.ships.size).toBe(2);
    const lingeringOnly = lingeringPoses.filter((p) => p.isActive === false);
    expect(lingeringOnly.length).toBeGreaterThan(0);

    // The FIRST snapshot's lingering pose should be at the abandon
    // position. Worker is idle on this body (no input → only drag, no
    // collision because the fresh ship spawned 200+ units away). So
    // the pose should be very close to (ABANDON_X, ABANDON_Y).
    const first = lingeringOnly[0]!;
    expect(
      Math.hypot(first.x - ABANDON_X, first.y - ABANDON_Y),
      [
        `Lingering hull pose was reset across the fresh-spawn-displaces`,
        `transition. Expected the body to stay at the abandon position`,
        `(${ABANDON_X}, ${ABANDON_Y}), got (${first.x.toFixed(3)}, ${first.y.toFixed(3)}).`,
        ``,
        `Likely cause: the worker's REKEY_SHIP handler isn't preserving`,
        `the body's Rapier translation, OR the broadcast is reading from`,
        `the wrong SAB slot, OR the lingering body's slot in SAB is being`,
        `zeroed somewhere in the fresh-spawn path.`,
      ].join('\n'),
    ).toBeLessThan(5); // tight bound — body shouldn't drift more than a few units in 300ms

    await harness.disconnectClient(client2);
  }, 20_000);
});
