/**
 * A0 — structure-system scale MEASUREMENT (plan soft-leaping-truffle v2).
 *
 * Boots a real SectorRoom seeded with a rule-valid structure lattice of N
 * structures (+ a closed shield-pylon fence) and measures, on the real code:
 *  - server ms: the 1 Hz grid pulse, the 10 Hz turret tick (with drones
 *    present for the O(turrets × entities) target scan), and the structures
 *    snapshot-slice rebuild;
 *  - wire bytes (A2): the room-state JOIN payload (the server serializer's
 *    full state), the state PATCH bytes an observer receives while the base
 *    idles and while it is under fire, and the snapshot's slim
 *    `structureTargets` slice (packed with `@colyseus/msgpackr`);
 *  - liveness of the lattice itself (all built, powered, walls formed), so the
 *    numbers measure a WORKING base, not a broken one.
 *
 * Writes `diag/structure-scale/a0-measure.json` (the ledger source for
 * `src/shared-types/structureBudgets.ts`). It asserts only that the seeded base
 * works — budgets are enforced by the later phases' locks, against these
 * numbers. Timings are medians on the dev box; byte counts are exact.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { matchMaker } from 'colyseus';
import { pack } from '@colyseus/msgpackr';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

// Phase V: at the large footprints a fenced lattice stays inside a sector
// (±5000 u) up to 600 structures (664 with the fence); 650+ runs past the edge.
const SIZES = [30, 100, 400, 600] as const;
const SNAPSHOT_HZ = 20;
const DRONES = 300;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
function time(fn: () => void, reps: number): { median: number; max: number } {
  const xs: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn();
    xs.push(performance.now() - t0);
  }
  return { median: +median(xs).toFixed(3), max: +Math.max(...xs).toFixed(3) };
}

const results: Record<string, unknown>[] = [];

describe('A0 — structure scale measurement', () => {
  let h: SectorTestHarness | undefined;
  afterEach(async () => {
    if (h) await h.cleanup();
    h = undefined;
  }, 20_000);

  it.each(SIZES)('N=%i lattice + fence: seeds a working base; measure cost', async (n) => {
    h = await bootSectorTestServer({ droneCount: 0, asteroidConfig: [], scaleGrid: { n, seed: 7, fence: true }, defaultSpawnX: 0, defaultSpawnY: -9000 });
    const cr = await h.connectAs(randomUUID());
    const room = matchMaker.getLocalRoomById(cr.roomId) as unknown as SectorRoom;
    const internal = room._internals;

    // Drones scattered over the sector for the turret target scan.
    for (let i = 0; i < DRONES; i++) {
      const a = (i * 2.399963) % (Math.PI * 2);
      const r = 2500 + ((i * 7919) % 2400);
      internal.spawnTestDrone(`scale-drone-${i}`, Math.cos(a) * r, Math.sin(a) * r);
    }
    internal.pulseStructureGrid();

    const slice = internal.getStructuresSlice() ?? [];
    const rows = slice.length;
    let built = 0, powered = 0, walls = 0, kinds = new Map<string, number>();
    for (const rec of internal.structureRegistry.all()) kinds.set(rec.kind, (kinds.get(rec.kind) ?? 0) + 1);
    for (const r of slice) {
      if (r.built) built++;
      if (r.powered) powered++;
      if (r.wallActive) walls++;
    }
    // The base WORKS: everything built + powered, the fence is up.
    expect(rows).toBeGreaterThanOrEqual(n);
    expect(built).toBe(rows);
    expect(powered).toBe(rows);
    expect(walls).toBeGreaterThan(0);

    // A2 wire: join payload, patches (idle + under fire), snapshot targets.
    const serializer = (room as unknown as { _serializer: { getFullState(c?: unknown): Uint8Array } })._serializer;
    const joinStateBytes = serializer.getFullState().length;
    const targets = (room as unknown as { structuresSlice?: number[] }).structuresSlice;
    const targetsBytesPerSnapshot = targets ? pack(targets).length : 0;
    const ws = (cr as unknown as { connection: { transport: { ws: { addEventListener(t: string, f: (e: { data: unknown }) => void): void } } } }).connection.transport.ws;
    let patchBytes = 0;
    ws.addEventListener('message', (e) => {
      const d = e.data as ArrayBuffer | Uint8Array;
      const u8 = d instanceof Uint8Array ? d : new Uint8Array(d as ArrayBuffer);
      if (u8[0] === 15) patchBytes += u8.length; // ROOM_STATE_PATCH
    });
    const pulseFor = async (ms: number, hit: boolean): Promise<number> => {
      patchBytes = 0;
      const ids: string[] = [];
      for (const rec of internal.structureRegistry.all()) if (rec.kind !== 'shield_pylon' && rec.kind !== 'capital') ids.push(rec.id);
      const t0 = Date.now();
      let k = 0;
      while (Date.now() - t0 < ms) {
        // The room's own 1 Hz pulse + 10 Hz turret tick sync the state.
        if (hit) for (let j = 0; j < 3; j++) internal.applyDamage(ids[(k++ * 7) % ids.length]!, 'measure', 1, 0, 0);
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 200));
      return Math.round((patchBytes * 1000) / ms);
    };
    const patchIdleBytesPerSec = await pulseFor(3000, false);
    const patchCombatBytesPerSec = await pulseFor(3000, true); // ~30 hits/s
    const pulse = time(() => internal.pulseStructureGrid(), 15);
    const turret = time(() => internal.tickStructureTurrets(), 40);
    const rebuild = time(() => internal.rebuildStructuresSlice(), 40);
    const turrets = kinds.get('turret') ?? 0;
    // Break the turret tick into its parts (it runs four things every 100 ms).
    const priv = room as unknown as {
      structureGrid: { tickTurrets(now: number): void; tickMiners(now: number): void };
      shieldWalls: { update(now: number): void };
      turretTargetGridFresh: boolean;
    };
    const parts = {
      tickTurrets: time(() => { priv.turretTargetGridFresh = false; priv.structureGrid.tickTurrets(Date.now()); }, 40),
      tickMiners: time(() => priv.structureGrid.tickMiners(Date.now()), 40),
      shieldWallsUpdate: time(() => priv.shieldWalls.update(Date.now()), 40),
      sliceRebuild: rebuild,
    };

    const row = {
      n,
      structures: rows,
      fencePylons: kinds.get('shield_pylon') ?? 0,
      turrets,
      drones: DRONES,
      joinStateBytes,
      patchIdleBytesPerSec,
      patchCombatBytesPerSec,
      targetsBytesPerSnapshot,
      targetsKBPerSecPerClient: +((targetsBytesPerSnapshot * SNAPSHOT_HZ) / 1024).toFixed(2),
      // A2: sleeping out-of-interest structures ride every 5th 1 Hz full refresh.
      binaryFullRefreshBytesPerSecPerClient: Math.round((rows * 34) / 5),
      pulseMs: pulse,
      turretTickMs: turret,
      turretTickParts: parts,
      turretTickMsPerSec: +(turret.median * 10).toFixed(2),
      sliceRebuildMs: rebuild,
      sliceRebuildMsPerSec: +(rebuild.median * 11).toFixed(2), // 10 Hz turret tick + 1 Hz pulse
    };
    results.push(row);
    // eslint-disable-next-line no-console
    console.log('[a0]', JSON.stringify(row));
  }, 120_000);

  it('writes the ledger source', () => {
    mkdirSync('diag/structure-scale', { recursive: true });
    writeFileSync('diag/structure-scale/a0-measure.json', JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2));
    expect(results.length).toBe(SIZES.length);
  });
});
