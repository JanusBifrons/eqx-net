/**
 * Campaign PR 2.1 (anti-patterns review 2026-07, A4 / Part D #1) — failing-
 * first lock for the HOSTILITY BIT ON THE SNAPSHOT.
 *
 * Playtest history (6+ iterations, "you've assured me it's working multiple
 * times"): hostile drones render as NEUTRAL. Root cause: hostility reached
 * the client ONLY via the discrete `bot_aggro` / `damage` events — no
 * snapshot carrier existed (invariant #16, written from this bug class). A
 * player who joins mid-wave, or drops one packet, has no way to reconstruct
 * "this drone is hostile to me" until the director's ~1.5 s re-pulse — and
 * a roaming-then-waved drone could sit visually neutral while attacking.
 *
 * Contract locked here: the slim `SnapshotMessage.drones[]` slice carries
 * `hostile: true` for a drone hostile TO THE RECIPIENT (per-recipient slice,
 * so the bit is viewer-relative, exactly matching the render semantics).
 * Emit-when-true — neutral drones add zero bytes. RED on pre-fix code: the
 * field never appears no matter how hostile the drone is.
 *
 * Reproduction uses the bespoke triggers (root CLAUDE.md table): a
 * deterministic in-interest drone via `dronePoses`, marked hostile at join
 * via `startHostile` — the same flow the auto-fire E2E uses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages/snapshotMessages.js';

describe('SectorRoom integration — hostility rides the drone snapshot slice (campaign 2.1)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    // Engineering room (sectorKey: null) — the `startHostile` bespoke trigger
    // is deliberately IGNORED on galaxy rooms (anti-force-aggro safeguard).
    harness = await bootSectorTestServer({
      sectorKey: null,
      droneCount: 0,
      testMode: true,
      dronePoses: [{ kind: 'fighter', x: 150, y: 0 }],
    });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('a drone made hostile at join carries hostile:true in the recipient snapshot', { timeout: 15_000 }, async () => {
    const p1 = randomUUID();
    const cr = await harness.connectActive(p1, { startHostile: true });

    // Teleport the player beside the drone so it is IN INTEREST (the spawn
    // pose is random; the drone sits at an absolute (150, 0)). Same
    // _internals SET_POSITION pattern the ramming spec uses.
    const room = matchMaker.getLocalRoomById(cr.roomId) as unknown as SectorRoom;
    room._internals.postToWorker({
      type: 'SET_POSITION', entityId: p1, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0,
    });

    // The sector idles without motion; thrust wakes the broadcast loop.
    await harness.sendThrust(cr);

    // Poll snapshots until the drone slice reports the hostile bit (or the
    // deadline trips). On pre-fix code the field NEVER appears — the loop
    // exhausts and the assertion below fails loudly.
    const deadline = Date.now() + 8_000;
    let sawHostile = false;
    while (Date.now() < deadline && !sawHostile) {
      const snap: SnapshotMessage = await harness.waitForSnapshot(cr, 2_000);
      const entry = snap.drones?.find((dr) => dr.hostile === true);
      if (entry) sawHostile = true;
    }
    expect(
      sawHostile,
      'no snapshot carried drones[].hostile === true for a startHostile drone — hostility is still event-only (invariant #16 violation)',
    ).toBe(true);
  });
});
