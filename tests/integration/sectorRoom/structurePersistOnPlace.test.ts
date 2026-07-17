/**
 * Campaign 6.3 (anti-patterns review A-structures / Part D #14) — persist-on-place.
 *
 * Reproduction: sector snapshots were written ONLY by the 60 s cadence timer
 * (+ onDispose). A structure placed and then lost to a CRASH (no onDispose)
 * within that window simply vanished — up to 60 s of construction gone, the
 * exact "structures lost after server reset" family the v3 persistence work
 * was meant to close. The fix: placement / removal / construction-completion
 * schedule an event-driven THROTTLED persist (2 s coalesce), shrinking the
 * crash window from ≤60 s to ≤~2 s.
 *
 * The test drives the REAL `place_structure` message into a real room and
 * asserts a SNAPSHOT persistence op carrying the structure reaches the sink
 * WITHOUT the 60 s cadence (the durable row a post-crash hydrate would read).
 * Pre-fix this is RED: no SNAPSHOT op arrives inside the wait window (the
 * cadence timer needs 3600 ticks and onDispose only fires on graceful
 * teardown, which a crash never runs).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

const SECTOR = 'sol-prime';

interface SnapshotOp {
  type: string;
  sectorId?: string;
  payloadJson?: string;
}

describe('SectorRoom integration — persist-on-place (campaign 6.3)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: SECTOR,
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
    });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('placing a structure persists a snapshot within the throttle window (no 60 s cadence, no onDispose)', async () => {
    // `connectAs` (not connectActive) — placement resolves `owner` from the
    // join-time session→player map, no active hull needed (the same dodge as
    // structurePlacementValidation.test.ts).
    const room = await harness.connectAs('player-persist-on-place');
    await harness.advance(150);
    harness.sink.reset();

    // The real placement message — a Capital (constructionCost 0 ⇒ pre-built).
    room.send('place_structure', { type: 'place_structure', kind: 'capital', x: 400, y: 400 });

    // The event-driven persist is throttled (~2 s coalesce). Wait for the
    // SNAPSHOT op carrying the placed structure — far below the 60 s cadence,
    // and cleanup/onDispose has NOT run yet, so pre-fix nothing arrives.
    const deadline = Date.now() + 8_000;
    let found: SnapshotOp | undefined;
    while (Date.now() < deadline && !found) {
      found = (harness.sink.ops as SnapshotOp[]).find(
        (op) =>
          op.type === 'SNAPSHOT' &&
          op.sectorId === SECTOR &&
          typeof op.payloadJson === 'string' &&
          op.payloadJson.includes('"capital"'),
      );
      if (!found) await new Promise((r) => setTimeout(r, 200));
    }
    expect(found, 'no SNAPSHOT op with the placed structure arrived — crash window still open').toBeDefined();

    // The durable row a post-crash hydrate would read carries the full
    // reconstructable structure (owner + kind + pose).
    const payload = JSON.parse(found!.payloadJson!) as {
      structures?: Array<{ kind: string; owner: string; x: number; y: number }>;
    };
    const st = (payload.structures ?? []).find((s) => s.kind === 'capital');
    expect(st).toBeDefined();
    // The owner is the server-side playerId (the harness `connectAs` label is
    // an identify-handshake input, not necessarily the stored id) — assert a
    // real owner is recorded, plus the exact reconstructable pose.
    expect(st!.owner.length).toBeGreaterThan(0);
    expect(st!.x).toBe(400);
    expect(st!.y).toBe(400);
  }, 30_000);
});
