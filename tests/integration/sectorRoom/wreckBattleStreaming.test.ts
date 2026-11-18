/**
 * Wreck fields 0b (plan row 0b "ends with"; capital-destruction.md "Battle
 * wrecks stream"): a 3000-piece battle in a persisted room that streams its
 * battle wrecks keeps the live pieces within the battle caps while every
 * piece is saved: the FIFO eviction retires whole lineages to their rows
 * instead of deleting them (nothing is ever deleted), and a dispose flush
 * leaves rows holding every piece the battle made.
 *
 * The sub-cap cap is lowered to 200 so the sub-cap FIFO evicts too within a
 * few hundred kills; the capital cap is the real one (768).
 *
 * The integration build stubs `node:sqlite`, so the battle partition's store
 * is the real `terrainRecordStore` over an in-memory table
 * (`setBattleWreckStoreFactory`), as in `wreckRestart.test.ts`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { terrainRecordStore, type TerrainRecordStore } from '../../../src/server/db/terrainSql.js';
import { setBattleWreckStoreFactory } from '../../../src/server/rooms/wreckLineageSaves.js';
import { parseLineageRecord } from '../../../src/server/rooms/wreckLineageRecord.js';
import { MAX_LIVE_WRECK_PIECES } from '../../../src/core/destruction/wreckPieces.js';
import type { PersistOp } from '../../../src/core/contracts/IPersistenceSink.js';

const WRECK_KIND = 4;
const PARTITION = 'sol-prime|battle';
const SUBCAP_CAP = 200;
const TARGET_PIECES = 3000;

interface Row { rock_key: number; layout_version: number; pool: number | null; consumed: number; pose_x: null; pose_y: null; pose_angle: null; lineage: string | null }

/** The `terrain_records` table in memory: the sink applies the store's ops. */
function memoryTable() {
  const rows = new Map<string, Map<number, Row>>();
  let deletes = 0;
  const part = (k: string) => { let m = rows.get(k); if (!m) rows.set(k, m = new Map()); return m; };
  const apply = (op: PersistOp) => {
    if (op.type === 'TERRAIN_RECORD_PUT') {
      part(op.sectorKey).set(op.rockKey, { rock_key: op.rockKey, layout_version: op.layoutVersion, pool: op.pool, consumed: op.consumed ? 1 : 0, pose_x: null, pose_y: null, pose_angle: null, lineage: op.lineage ?? null });
    } else if (op.type === 'TERRAIN_RECORD_DELETE') { deletes++; part(op.sectorKey).delete(op.rockKey); }
  };
  const sink = { enqueueCritical: apply, enqueueVolatile: apply, enqueueCriticalAwaitable: async (op: PersistOp) => { apply(op); return {}; }, shutdown: async () => ({ drained: 0 }) };
  const db = { prepare: () => ({ all: (k: string) => [...part(k).values()], get: () => undefined, run: () => undefined }) };
  const factory = (p: string): TerrainRecordStore => terrainRecordStore(p, db as never, sink, { warn: () => {} }, () => 0);
  const savedPieces = () => {
    let n = 0;
    for (const r of part(PARTITION).values()) if (r.lineage !== null) n += parseLineageRecord(JSON.parse(r.lineage))!.pieces.length;
    return n;
  };
  return { factory, savedPieces, deletes: () => deletes };
}

type Internals = SectorRoom['_internals'];

describe('SectorRoom integration: battle wrecks stream (wreck fields 0b)', () => {
  let harness: SectorTestHarness | null = null;
  afterEach(async () => {
    setBattleWreckStoreFactory(null);
    if (harness) await harness.cleanup();
    harness = null;
  }, 20_000);

  it('a 3000-piece battle: live pieces stay within the battle caps, saved = every piece', async () => {
    const table = memoryTable();
    setBattleWreckStoreFactory(table.factory);
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
      capitalWrecks: true, subcapWrecks: true, battleWreckStreaming: true,
    });
    // A ship in the middle of the battle: its lineages stay near, so only the caps bound them.
    await harness.connectActive(randomUUID(), { shipKind: 'fighter', spawnX: 0, spawnY: -3000 });
    const internal: Internals = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    internal.setSubcapWreckCap(SUBCAP_CAP);

    const seen = new Set<string>();
    let maxLive = 0, maxSubcap = 0, n = 0;
    for (let batch = 0; batch < 200 && seen.size < TARGET_PIECES; batch++) {
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) {
        const id = `d${n++}`;
        const kind = i < 3 ? 'battleship' : 'fighter';
        if (internal.spawnTestDrone(id, (i - 4) * 2000, (batch % 3) * 2500, kind)) ids.push(id);
      }
      await harness.advance(50);
      for (const id of ids) internal.applyDamage(id, 'shooter-x', 1e9);
      for (const r of internal.swarmRegistry.all()) if (r.kind === WRECK_KIND) seen.add(r.id);
      const c = internal.wreckCounts();
      maxLive = Math.max(maxLive, c.total);
      maxSubcap = Math.max(maxSubcap, c.subcap);
    }
    expect(seen.size, 'the battle made 3000 pieces').toBeGreaterThanOrEqual(TARGET_PIECES);
    expect(maxSubcap, 'sub-cap live <= its cap').toBeLessThanOrEqual(SUBCAP_CAP);
    expect(maxLive, 'live <= both battle caps').toBeLessThanOrEqual(MAX_LIVE_WRECK_PIECES + SUBCAP_CAP);
    expect(table.deletes(), 'eviction deleted no row').toBe(0);

    internal.flushWreckSaves(true);
    expect(table.savedPieces(), 'saved = every piece the battle made').toBe(seen.size);
    console.log(`[wreck stream] ${seen.size} pieces made, live max ${maxLive} (sub-cap ${maxSubcap}), saved ${table.savedPieces()}`);
  }, 120_000);
});
