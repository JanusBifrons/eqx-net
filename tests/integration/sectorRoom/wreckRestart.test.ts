/**
 * Wreck fields 0a2c (capital-destruction.md "Save and restore"): battle
 * wrecks survive a server restart. A shell breaks a heavy cruiser up, one
 * piece is worn into a child wreck, the room is disposed (its last flush) and
 * a fresh room boots on the same saved rows: the same pieces come back at
 * their saved poses and wear, and every live wreck's ancestor chain resolves
 * through the shared core resolver (what a client draws, #15). A fully
 * salvaged lineage deletes its row; a corrupt row is dropped with a warning
 * and the room still boots.
 *
 * The integration build stubs `node:sqlite`, so the battle partition's store
 * is the real `terrainRecordStore` over an in-memory table
 * (`setBattleWreckStoreFactory`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { WEAPONS } from '../../../src/core/combat/WeaponCatalogue.js';
import { WRECK_CRACK_MS } from '../../../src/shared-types/wreckTiming.js';
import { terrainRecordStore, type TerrainRecordStore } from '../../../src/server/db/terrainSql.js';
import { setBattleWreckStoreFactory } from '../../../src/server/rooms/wreckLineageSaves.js';
import { parseLineageRecord } from '../../../src/server/rooms/wreckLineageRecord.js';
import { rebuildWreckPieces, resolveChildWreckPieces } from '../../../src/core/destruction/wreckDescriptorGeometry.js';
import type { PersistOp } from '../../../src/core/contracts/IPersistenceSink.js';
import type { WreckDescriptor } from '../../../src/shared-types/messages/wreckDescriptor.js';

const WRECK_KIND = 4;
const KIND = 'heavy-cruiser';
const PARTITION = 'sol-prime|battle';

interface Row { rock_key: number; layout_version: number; pool: number | null; consumed: number; pose_x: null; pose_y: null; pose_angle: null; lineage: string | null }

/** The `terrain_records` table in memory: the sink applies the store's ops. */
function memoryTable() {
  const rows = new Map<string, Map<number, Row>>();
  const part = (k: string) => { let m = rows.get(k); if (!m) rows.set(k, m = new Map()); return m; };
  const apply = (op: PersistOp) => {
    if (op.type === 'TERRAIN_RECORD_PUT') {
      part(op.sectorKey).set(op.rockKey, { rock_key: op.rockKey, layout_version: op.layoutVersion, pool: op.pool, consumed: op.consumed ? 1 : 0, pose_x: null, pose_y: null, pose_angle: null, lineage: op.lineage ?? null });
    } else if (op.type === 'TERRAIN_RECORD_DELETE') part(op.sectorKey).delete(op.rockKey);
  };
  const sink = { enqueueCritical: apply, enqueueVolatile: apply, enqueueCriticalAwaitable: async (op: PersistOp) => { apply(op); return {}; }, shutdown: async () => ({ drained: 0 }) };
  const db = { prepare: () => ({ all: (k: string) => [...part(k).values()], get: () => undefined, run: () => undefined }) };
  const warns: string[] = [];
  const factory = (p: string): TerrainRecordStore => terrainRecordStore(p, db as never, sink, { warn: (_f, m) => { warns.push(m); } }, () => 0);
  const lineageRows = () => [...part(PARTITION).values()].filter((r) => r.lineage !== null);
  return { part, warns, factory, lineageRows };
}

type Internals = SectorRoom['_internals'];

async function boot(): Promise<{ harness: SectorTestHarness; internal: Internals }> {
  const harness = await bootSectorTestServer({
    sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
    capitalWrecks: true,
  });
  // The room boots on its first join (and restores its wrecks then).
  await harness.connectActive(randomUUID(), { shipKind: 'fighter', spawnX: -8000, spawnY: 0 });
  return { harness, internal: (harness.getServerRoom() as unknown as SectorRoom)._internals };
}

/** Kill a heavy cruiser with one shell; wait out the crack hold. */
async function breakCruiser(harness: SectorTestHarness, internal: Internals): Promise<void> {
  const kind = getShipKind(KIND);
  const victim = randomUUID();
  await harness.connectActive(victim, { shipKind: KIND, spawnX: 8000, spawnY: 0, initialHull: 1, initialShield: 0 });
  internal.setWreckSeed(5);
  await harness.advance(150);
  const pose = internal.playerPose(victim)!;
  const c = Math.cos(pose.angle), s = Math.sin(pose.angle);
  internal.spawnTestProjectile('bb-shooter', pose.x + kind.radius * 0.6 * c, pose.y + kind.radius * 0.6 * s, -c * 3000, -s * 3000, 'naval_xl', 1400);
  for (let i = 0; i < 40 && internal.wreckDescriptors().length === 0; i++) await harness.advance(50);
  expect(internal.wreckDescriptors().length, 'the shell killed the cruiser and it broke up').toBeGreaterThan(0);
  await harness.advance(WRECK_CRACK_MS + 500);
}

const pieces = (internal: Internals) => [...internal.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND);

/** Live pieces keyed by (their wreck's seed, piece index): stable across a restart. */
function pieceTable(internal: Internals): Map<string, { integrity: number; x: number; y: number; angle: number }> {
  const seedOf = new Map(internal.wreckDescriptors().map((d) => [d.wreckId, d.seed]));
  const out = new Map<string, { integrity: number; x: number; y: number; angle: number }>();
  for (const r of pieces(internal)) {
    const p = internal.wreckState(r.id)!;
    out.set(`${seedOf.get(r.wreckId!)}:${r.componentIndex}`, { integrity: internal.wreckIntegrity(r.id)!, x: p.x, y: p.y, angle: p.angle });
  }
  return out;
}

describe('SectorRoom integration: battle wrecks survive a restart', () => {
  let harness: SectorTestHarness | null = null;
  afterEach(async () => {
    delete WEAPONS.get('laser')!.targetFactor;
    setBattleWreckStoreFactory(null);
    if (harness) await harness.cleanup();
    harness = null;
  }, 10_000);

  it('a broken-up, re-split capital comes back with the same pieces, poses and wear', async () => {
    const table = memoryTable();
    setBattleWreckStoreFactory(table.factory);
    let internal: Internals;
    ({ harness, internal } = await boot());
    await breakCruiser(harness, internal);

    // Re-split the biggest piece (factor-1 laser: the mining-laser stand-in).
    WEAPONS.get('laser')!.targetFactor = { wreck: 1 };
    const big = pieces(internal).reduce((a, b) => ((internal.wreckIntegrity(b.id) ?? 0) > (internal.wreckIntegrity(a.id) ?? 0) ? b : a));
    const at = internal.wreckState(big.id)!;
    internal.applyDamage(big.id, 'bb-shooter', internal.wreckIntegrity(big.id)! + 1, at.x - 1, at.y, 1, 0, 'laser');
    expect(internal.wreckDescriptors().some((d) => d.parentWreck !== undefined), 'the piece split into a child wreck').toBe(true);
    await harness.advance(100);
    // Wear one more piece a little: its wear must come back too.
    const worn = pieces(internal)[0]!;
    const wp = internal.wreckState(worn.id)!;
    internal.applyDamage(worn.id, 'bb-shooter', internal.wreckIntegrity(worn.id)! * 0.25, wp.x - 1, wp.y, 1, 0, 'laser');
    await harness.advance(1500);
    const before = pieceTable(internal);
    const descsBefore = internal.wreckDescriptors().length;

    await harness.cleanup(); // dispose: the last flush
    harness = null;
    const rows = table.lineageRows();
    expect(rows, 'one lineage, one row').toHaveLength(1);
    const rec = parseLineageRecord(JSON.parse(rows[0]!.lineage!))!;
    expect(rec).not.toBeNull();
    expect(rec.pieces.length).toBe(before.size);

    ({ harness, internal } = await boot());
    const after = pieceTable(internal);
    expect(after.size, 'the same piece count').toBe(before.size);
    expect(internal.wreckDescriptors().length, 'the same wrecks (dead root included)').toBe(descsBefore);
    for (const [key, b] of before) {
      const a = after.get(key);
      expect(a, `piece ${key} came back`).toBeDefined();
      expect(a!.integrity, `piece ${key} wear`).toBeCloseTo(b.integrity, 6);
      expect(Math.hypot(a!.x - b.x, a!.y - b.y), `piece ${key} pose`).toBeLessThan(5);
    }
    // Restored at rest, drawn cool, on the saved row.
    for (const d of internal.wreckDescriptors()) expect(d.deathTick).toBeUndefined();
    const descs = new Map<number, WreckDescriptor>(internal.wreckDescriptors().map((d) => [d.wreckId, d]));
    for (const r of pieces(internal)) {
      const d = descs.get(r.wreckId!)!;
      const geom = d.parentWreck === undefined ? rebuildWreckPieces(d) : resolveChildWreckPieces(d, (id) => descs.get(id));
      expect(geom, `wreck ${d.wreckId}'s chain resolves`).not.toBeNull();
      expect(internal.wreckParts(r.id)).toEqual(geom!.find((g) => g.index === r.componentIndex)!.parts);
    }
    internal.flushWreckSaves(true);
    expect(table.lineageRows().map((r) => r.rock_key), 'the row keeps its serial').toEqual([rows[0]!.rock_key]);
    console.log(`[wreck restart] ${before.size} pieces in ${descsBefore} wrecks came back`);
  }, 90_000);

  it('a fully salvaged lineage deletes its row', async () => {
    const table = memoryTable();
    setBattleWreckStoreFactory(table.factory);
    let internal: Internals;
    ({ harness, internal } = await boot());
    await breakCruiser(harness, internal);
    internal.flushWreckSaves(false);
    expect(table.lineageRows()).toHaveLength(1);
    for (const r of pieces(internal)) internal.evictSwarm(r.id);
    expect(internal.wreckDescriptors()).toHaveLength(0);
    internal.flushWreckSaves(false);
    expect(table.lineageRows(), 'the row is gone').toHaveLength(0);
  }, 60_000);

  it('a corrupt row is dropped with a warning and the room still boots', async () => {
    const table = memoryTable();
    table.part(PARTITION).set(-1, { rock_key: -1, layout_version: 0, pool: null, consumed: 0, pose_x: null, pose_y: null, pose_angle: null, lineage: '{"v":1,"fractu' });
    table.part(PARTITION).set(-2, { rock_key: -2, layout_version: 0, pool: null, consumed: 0, pose_x: null, pose_y: null, pose_angle: null, lineage: '{"v":1,"fractureAlgo":1,"nodes":[],"pieces":[]}' });
    setBattleWreckStoreFactory(table.factory);
    let internal: Internals;
    ({ harness, internal } = await boot());
    expect(table.warns.length, 'one warning per bad row').toBe(2);
    expect(table.lineageRows(), 'both rows dropped').toHaveLength(0);
    expect(internal.wreckDescriptors()).toHaveLength(0);
    await breakCruiser(harness, internal); // the room works
    internal.flushWreckSaves(false);
    expect(table.lineageRows()).toHaveLength(1);
  }, 60_000);
});
