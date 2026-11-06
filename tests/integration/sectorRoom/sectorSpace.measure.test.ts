/**
 * Round 3 C (capital ships, plan eager-sauteeing-curry) — sector-space
 * MEASUREMENT: what the bigger sectors (SECTOR_SPACE_SCALE) cost.
 *
 * Boots a SectorRoom populated the way galaxy placement now is: DRONES drones
 * and ROCKS asteroids spread over the whole playable disc (a sunflower spiral
 * out to 90 % of SECTOR_PLAYABLE_HALF_EXTENT). Parks an active pilot at the
 * origin and measures on the real code:
 *  - server ms per `update()` tick (median / p95 over a ~3 s window);
 *  - wire bytes per second the pilot receives (all room traffic);
 *  - how many swarm entities sit in the pilot's interest window.
 *
 * Run once per scale (the knob is read at module load):
 *   EQX_SECTOR_SCALE=1 npx vitest run tests/integration/sectorRoom/sectorSpace.measure.test.ts
 *   EQX_SECTOR_SCALE=4 npx vitest run tests/integration/sectorRoom/sectorSpace.measure.test.ts
 * Each run writes `diag/sector-space/scale-<n>.json`. It asserts only that the
 * room ran (ticks happened, bytes arrived); the numbers are for the ledger.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { SECTOR_SPACE_SCALE, SECTOR_PLAYABLE_HALF_EXTENT } from '../../../src/shared-types/sectorBounds.js';

const DRONES = 200;
const ROCKS = 300;
const WINDOW_MS = 3000;

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor(s.length * p))]!.toFixed(3);
}

describe('round 3 C — sector space measurement', () => {
  let h: SectorTestHarness | undefined;
  afterEach(async () => {
    if (h) await h.cleanup();
    h = undefined;
  }, 20_000);

  it(`scale ${SECTOR_SPACE_SCALE}: populated sector, pilot at origin`, async () => {
    // Time every tick of every SectorRoom through the prototype (the loop calls this.update()).
    const proto = SectorRoom.prototype as unknown as { update(): void };
    const orig = proto.update;
    const tickMs: number[] = [];
    let recording = false;
    proto.update = function (this: unknown): void {
      if (!recording) { orig.call(this); return; }
      const t0 = performance.now();
      orig.call(this);
      tickMs.push(performance.now() - t0);
    };
    try {
      h = await bootSectorTestServer({ droneCount: 0, asteroidConfig: [], defaultSpawnX: 0, defaultSpawnY: 0 });
      const playerId = randomUUID();
      const cr = await h.connectActive(playerId);
      const room = matchMaker.getLocalRoomById(cr.roomId) as unknown as {
        snapshotBroadcaster: { interestScratch: Map<string, Set<number>> };
        swarmRegistry: { all(): Iterable<unknown> };
        _internals: {
          spawnTestDrone(id: string, x: number, y: number): boolean;
          spawnTestAsteroid(id: string, x: number, y: number, radius: number): boolean;
        };
      };
      // Sunflower spread over the playable disc (skip the pilot's own cell).
      const R = SECTOR_PLAYABLE_HALF_EXTENT * 0.9;
      const N = DRONES + ROCKS;
      for (let i = 0; i < N; i++) {
        const r = Math.sqrt((i + 0.5) / N) * R;
        const a = i * 2.399963;
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        if (i % 5 < 2 && i / 5 * 2 < DRONES) room._internals.spawnTestDrone(`m-drone-${i}`, x, y);
        else room._internals.spawnTestAsteroid(`m-rock-${i}`, x, y, 30);
      }
      const ws = (cr as unknown as { connection: { transport: { ws: { addEventListener(t: string, f: (e: { data: unknown }) => void): void } } } }).connection.transport.ws;
      let bytes = 0;
      ws.addEventListener('message', (e) => {
        const d = e.data as ArrayBuffer | Uint8Array;
        bytes += d instanceof Uint8Array ? d.length : (d as ArrayBuffer).byteLength;
      });

      await h.advance(1000); // settle
      bytes = 0;
      recording = true;
      const t0 = Date.now();
      while (Date.now() - t0 < WINDOW_MS) {
        h.sendThrust(cr); // keep the sector awake (idle sectors suppress snapshots)
        await h.advance(250);
      }
      recording = false;
      const elapsed = Date.now() - t0;

      let swarmTotal = 0;
      for (const _ of room.swarmRegistry.all()) swarmTotal++;
      const inInterest = room.snapshotBroadcaster.interestScratch.get(cr.sessionId)?.size ?? 0;
      const row = {
        sectorScale: SECTOR_SPACE_SCALE,
        halfExtent: SECTOR_PLAYABLE_HALF_EXTENT,
        drones: DRONES,
        rocks: ROCKS,
        swarmTotal,
        inInterest,
        ticks: tickMs.length,
        tickMedianMs: pct(tickMs, 0.5),
        tickP95Ms: pct(tickMs, 0.95),
        bytesPerSec: Math.round((bytes * 1000) / elapsed),
      };
      mkdirSync('diag/sector-space', { recursive: true });
      writeFileSync(`diag/sector-space/scale-${SECTOR_SPACE_SCALE}.json`, JSON.stringify(row, null, 2));
      console.log('[sector-space]', JSON.stringify(row));

      expect(tickMs.length).toBeGreaterThan(60);
      expect(bytes).toBeGreaterThan(0);
    } finally {
      proto.update = orig;
    }
  }, 30_000);
});
