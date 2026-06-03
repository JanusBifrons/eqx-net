/**
 * Regression: lingering hull near origin gets reset to exact (0, 0, 0).
 *
 * USER REPORTED (verbatim, 2026-05-13):
 *   "It was the ship I was piloting, I left is just off 0,0...
 *    then I went back to menu, selected a new ship and went to test
 *    it. And it had moved from just off 0,0 to exactly 0,0 and
 *    facing exactly north."
 *
 * Distinct from `lingeringPosePreserved.test.ts`:
 *   - That test spawned the abandon at (250, -180) — well away from
 *     origin. My push-fix REKEY preserves the pose there.
 *   - This test spawns NEAR origin (matching the user's "just off
 *     0,0") to catch any path that resets-to-default-spawn.
 *
 * If this test fails on the current code, there's a path I haven't
 * identified that resets the body to (0, 0, 0) when the rejoin uses
 * the post-auth landing flow.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';

const PID = randomUUID();
// "Just off 0, 0" — non-zero but small, matches the user's exact words.
const ABANDON_X = 3.5;
const ABANDON_Y = 1.2;
const ABANDON_ANGLE = 0.3; // ~17 degrees off "north" so the angle reset
                           // (to exactly 0) is also visible.

describe('SectorRoom integration — lingering hull near origin keeps its pose', () => {
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

  it('abandon near origin, return-to-menu, fresh-spawn — lingering hull stays at abandon pose, not (0,0,0)', async () => {
    const client1 = await harness.connectActive(PID, {
      spawnX: ABANDON_X,
      spawnY: ABANDON_Y,
      shipKind: 'fighter',
    });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === PID });
    await harness.advance(200);

    const state = harness.getServerRoom()!.state as SectorState;
    const [_originalShipId] = [...state.ships.entries()][0]!;

    // Disconnect, like a "return to menu" — the connection drops, the
    // ship enters the linger branch.
    await harness.disconnectClient(client1);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === PID });

    // The user typically goes away for a few seconds (menu interaction,
    // picking a ship, etc) before reconnecting. Worker keeps stepping;
    // velocity damps but pose stays put.
    await harness.advance(1500);

    // Re-enter the sector — they "selected a new ship". isNewShip:true is
    // the canonical fresh-spawn-displaces path the post-auth landing's
    // ShipPickerModal uses for "spawn a new ship in this sector". The
    // spawn position is a random scatter on galaxy rooms (no defaultSpawnX
    // set) — pick a deterministic non-origin position via JoinOptions so
    // the assertion can distinguish "lingering hull at abandon pose" from
    // "lingering hull at new active ship's pose".
    const FRESH_X = -120;
    const FRESH_Y = 80;
    const samples: Array<{ x: number; y: number; angle: number; isActive: boolean }> = [];
    const client2 = await harness.connectActive(PID, {
      isNewShip: true,
      shipKind: 'fighter',
      spawnX: FRESH_X,
      spawnY: FRESH_Y,
    });
    client2.onMessage('snapshot', (snap: unknown) => {
      const s = snap as SnapshotMessage;
      for (const [, entry] of Object.entries(s.states)) {
        samples.push({ x: entry.x, y: entry.y, angle: entry.angle, isActive: entry.isActive });
      }
    });

    // Wake the broadcast loop (idle sectors suppress snapshots).
    harness.sendThrust(client2);
    await harness.advance(400);

    const lingering = samples.filter((s) => s.isActive === false);
    expect(lingering.length).toBeGreaterThan(0);

    const first = lingering[0]!;
    // The (0, 0, 0) reset is the EXACT failure shape the user saw —
    // "exactly 0,0 and facing exactly north". Assert against all three
    // axes (x, y, angle) so a reset-to-default-spawn is caught.
    const isExactlyOriginNorth =
      Math.abs(first.x) < 0.001 && Math.abs(first.y) < 0.001 && Math.abs(first.angle) < 0.001;
    expect(
      isExactlyOriginNorth,
      [
        `Lingering hull was reset to exactly (0, 0, angle=0) — the`,
        `"moved from just off 0,0 to exactly 0,0 and facing exactly`,
        `north" smoke-test bug.`,
        ``,
        `Expected the body to stay near the abandon pose`,
        `(${ABANDON_X}, ${ABANDON_Y}, ${ABANDON_ANGLE.toFixed(3)}).`,
        `Actual:  (${first.x.toFixed(6)}, ${first.y.toFixed(6)}, ${first.angle.toFixed(6)}).`,
      ].join('\n'),
    ).toBe(false);

    // Also assert the body is close to the abandon pose (within a few
    // units; the body may have drifted slightly under residual velocity
    // damping but should not have moved tens of units).
    const dist = Math.hypot(first.x - ABANDON_X, first.y - ABANDON_Y);
    expect(dist).toBeLessThan(5);

    await harness.disconnectClient(client2);
  }, 25_000);
});
