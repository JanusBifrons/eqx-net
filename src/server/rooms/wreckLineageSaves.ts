/**
 * Battle wrecks survive a restart (wreck fields plan slice 0a2c;
 * docs/architecture/capital-destruction.md "Save and restore"). Every wreck
 * lineage of a room that saves its sector is one row in `terrain_records`
 * (partition `<sectorKey>|battle`, rock key `lineageRowKey(serial)`), its
 * JSON the `collectLineage` record (wreckLineageRecord.ts).
 *
 *  - SERIAL: a lineage gets its row serial (`nextLineageSerial`) the first
 *    time it is written, kept per lineage root (`serials`, root wreck id →
 *    serial); its re-split children belong to that root, so they share it.
 *  - WRITE: `CapitalWreckDeps.lineageTouched` marks a root dirty (a reused
 *    Set: no allocation on the hit or tick path, #14). `flush` runs on a
 *    game-clock timer every `WRECK_LINEAGE_FLUSH_MS` (never in tick) and on
 *    room dispose (`all`). It also re-saves every lineage with an awake
 *    piece, so a drifting, rammed or towed piece is saved where it comes to
 *    rest. A lineage with no live piece left deletes its row. The 60 s
 *    sector snapshot never writes wrecks.
 *  - RESTORE (room boot): each row is parsed (#3); a bad row, or one from
 *    another `FRACTURE_ALGO_VERSION`, is deleted with a `warn`. The tree is
 *    rebuilt with fresh u16 wreck ids and rewritten `parentWreck` links, its
 *    geometry resolved by the shared core resolver (the client's), and its
 *    live pieces spawned through the re-split / rock-cut piece spawn
 *    (`spawnWreckPieces` + `addWreck`) at their saved poses, at rest, with
 *    their saved integrity, no `deathTick` (drawn cool), asleep (the
 *    worker's `sleeping` spawn: FLAG_SLEEPING from step 1). The row keeps its
 *    serial, so later writes overwrite it.
 *
 * Restore and flush run at boot, on a timer and at dispose: they allocate.
 */
import { collectLineage, parseLineageRecord, WRECK_LINEAGE_UNBREAKABLE, type WreckLineageDeps, type WreckLineageRecord } from './wreckLineageRecord.js';
import { lineageRowKey, type TerrainRecordStore } from '../db/terrainSql.js';
import { terrainRecordStoreFor } from '../db/PersistenceWorker.js';
import { FRACTURE_ALGO_VERSION } from '../../core/destruction/fractureHull.js';
import { rebuildWreckPieces, resolveChildWreckPieces, wreckDescriptorUsable } from '../../core/destruction/wreckDescriptorGeometry.js';
import type { WreckFractureInputs, WreckPieceGeometry } from '../../core/destruction/wreckPieceFrame.js';
import { wreckSourceOf } from '../../core/destruction/wreckSource.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import type { WreckDescriptor } from '../../shared-types/messages/wreckDescriptor.js';
import type { CapitalWreckDeps, LiveWreck, PieceKnock } from './capitalWreckTypes.js';
import { spawnWreckPieces, type WreckChildSpawn, type WreckPiecePose, type WreckResplitHost } from './wreckResplit.js';

/** Game ms between lineage flushes: a crash loses at most this much wreck
 *  history; each flush writes only the lineages that changed or still move. */
export const WRECK_LINEAGE_FLUSH_MS = 5000;

let storeOverride: ((partition: string) => TerrainRecordStore) | null = null;

/** Tests: build the battle partition's store with `f` (an in-memory one)
 *  instead of the process database; null restores the default. */
export function setBattleWreckStoreFactory(f: ((partition: string) => TerrainRecordStore) | null): void { storeOverride = f; }

/** The store of a sector's battle partition (`<sectorKey>|battle`). */
export function battleWreckStore(sectorKey: string): TerrainRecordStore {
  const partition = `${sectorKey}|battle`;
  return storeOverride !== null ? storeOverride(partition) : terrainRecordStoreFor(partition);
}

/** What the saves read from `CapitalWreckSubsystem` (`lineageState()`). */
export interface WreckLineageState {
  readonly wrecks: ReadonlyMap<number, LiveWreck>;
  readonly pieceWreck: ReadonlyMap<string, number>;
  readonly knock: ReadonlyMap<string, PieceKnock>;
  readonly host: WreckResplitHost;
  readonly d: CapitalWreckDeps;
}

const POSE: WreckPiecePose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };

export class BattleWreckSaves {
  private readonly dirty = new Set<number>();
  /** Lineage root wreck id → its row serial. */
  private readonly serials = new Map<number, number>();
  private readonly deps: WreckLineageDeps;

  constructor(private readonly s: WreckLineageState, private readonly store: TerrainRecordStore) {
    this.deps = {
      forEachWreck: (visit) => { for (const w of s.wrecks.values()) visit(w); },
      forEachLivePiece: (wreckId, visit) => {
        const w = s.wrecks.get(wreckId);
        if (w === undefined || w.pieces <= 0 || s.d.piecePoseInto === undefined) return;
        for (const id of w.ids) {
          const k = s.knock.get(id);
          if (k === undefined || s.pieceWreck.get(id) !== wreckId || !s.d.piecePoseInto(id, POSE)) continue;
          visit(k.index, POSE.x, POSE.y, POSE.angle, k.integrity);
        }
      },
    };
  }

  /** Lineage `root` changed (`CapitalWreckDeps.lineageTouched`). */
  touch(root: number): void { this.dirty.add(root); }

  /** Write the dirty lineages, plus every lineage with an awake piece
   *  (`all`: every live lineage, the room's dispose). */
  flush(all: boolean): void {
    const { wrecks, pieceWreck, knock, d } = this.s;
    if (all) { for (const w of wrecks.values()) this.dirty.add(w.root); }
    else if (d.pieceAsleep !== undefined) {
      for (const id of knock.keys()) {
        if (d.pieceAsleep(id)) continue;
        const w = wrecks.get(pieceWreck.get(id) ?? -1);
        if (w !== undefined) this.dirty.add(w.root);
      }
    }
    for (const root of this.dirty) this.write(root);
    this.dirty.clear();
  }

  private write(root: number): void {
    const rec = collectLineage(root, this.deps);
    let serial = this.serials.get(root);
    if (rec === null || rec.pieces.length === 0) {
      // Fully salvaged (or evicted): the row goes.
      if (serial !== undefined) this.store.deleteRecord(lineageRowKey(serial));
      this.serials.delete(root);
      return;
    }
    if (serial === undefined) { serial = this.store.nextLineageSerial(); this.serials.set(root, serial); }
    this.store.putLineage(serial, JSON.stringify(rec));
  }

  /** Room boot: bring every saved lineage back. Returns how many came back. */
  restoreAll(): number {
    let n = 0;
    for (const { serial, json } of this.store.lineages()) {
      let raw: unknown;
      try { raw = JSON.parse(json); } catch { raw = undefined; }
      const rec = raw === undefined ? null : parseLineageRecord(raw);
      if (rec === null) {
        const algo = (raw as { fractureAlgo?: unknown } | undefined)?.fractureAlgo;
        this.store.warn({ sectorKey: this.store.sectorKey, serial, fractureAlgo: algo, want: FRACTURE_ALGO_VERSION },
          algo !== undefined && algo !== FRACTURE_ALGO_VERSION ? 'battle wreck lineage from another fracture version, dropped' : 'battle wreck lineage row unreadable, dropped');
        this.store.deleteRecord(lineageRowKey(serial));
        continue;
      }
      const root = restoreLineage(this.s, rec);
      if (root === null) {
        this.store.warn({ sectorKey: this.store.sectorKey, serial }, 'battle wreck lineage did not resolve or spawn, dropped');
        this.store.deleteRecord(lineageRowKey(serial));
        continue;
      }
      this.serials.set(root, serial);
      n++;
    }
    this.s.host.enforceCap(true);
    this.s.host.enforceCap(false);
    return n;
  }
}

/** The fracture inputs of a root descriptor (the chain's root). */
function rootInputs(d: WreckDescriptor): WreckFractureInputs {
  return {
    ...(d.rock !== undefined ? { rock: d.rock } : { kindId: d.parentKind as WreckFractureInputs['kindId'] }),
    seed: d.seed, killX: d.killX, killY: d.killY,
    killBlowDamage: d.killBlowDamage, recentDamageRate: d.recentDamageRate, snapChance: d.snapChance,
    ...(d.cutKind !== undefined ? { cutKind: d.cutKind } : {}),
    ...(d.cutAng !== undefined ? { cutAng: d.cutAng } : {}),
    ...(d.cutW !== undefined ? { cutW: d.cutW } : {}),
    ...(d.extraCuts !== undefined ? { extraCuts: d.extraCuts } : {}),
  };
}

/**
 * Rebuild one saved lineage. Returns its new root wreck id, or null when
 * nothing came back (geometry did not resolve, or no piece could spawn);
 * then nothing is left behind.
 */
export function restoreLineage(s: WreckLineageState, rec: WreckLineageRecord): number | null {
  const nodes = rec.nodes;
  const n = nodes.length;
  // Keep a node with a live piece, and every ancestor of one.
  const keep: boolean[] = new Array<boolean>(n).fill(false);
  for (const pc of rec.pieces) keep[pc.node] = true;
  for (let i = n - 1; i > 0; i--) if (keep[i]) keep[nodes[i]!.parent] = true;
  if (!keep[0]) return null;

  // 1. Descriptors with provisional ids (local index + 1), resolved through
  //    the shared resolver exactly as a client would (#15).
  const descs: WreckDescriptor[] = [];
  const geoms: Array<WreckPieceGeometry[] | null> = [];
  const byId = (id: number): WreckDescriptor | undefined => descs[id - 1];
  for (let i = 0; i < n; i++) {
    const nd = nodes[i]!;
    descs.push({ ...nd.desc, wreckId: i + 1, algoVersion: rec.fractureAlgo, ...(i > 0 ? { parentWreck: nd.parent + 1 } : {}) });
  }
  for (let i = 0; i < n; i++) {
    const d = descs[i]!;
    if (!keep[i]) { geoms.push(null); continue; }
    if (!wreckDescriptorUsable(d)) return null;
    const g = i === 0 ? rebuildWreckPieces(d) : resolveChildWreckPieces(d, byId);
    if (g === null) return null;
    geoms.push(g);
  }

  // 2. Fresh u16 ids and piece serials, then the pieces (children first, so a
  //    node whose pieces all failed to spawn and has no child is never added).
  const { host, d } = s;
  // Restored pieces are at rest: they spawn asleep (`sleeping`, no awake window).
  const quiet: CapitalWreckDeps = { ...d, pieceSplit: undefined, dropSalvage: undefined, spawnPiece: (spec) => d.spawnPiece({ ...spec, sleeping: true }) };
  const chainRoot = rootInputs(descs[0]!);
  const src = wreckSourceOf(chainRoot);
  const fifo = host.fifo(src.profile.id === 'capital', 'battle');
  const like = knockLike(src.ship, geoms[0]!);
  const ids: number[] = new Array<number>(n).fill(0);
  const serial: number[] = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) if (keep[i]) [ids[i], serial[i]] = host.newWreck();
  const spawned: Array<{ ids: string[]; mass: number }> = new Array(n);
  const live: boolean[] = new Array<boolean>(n).fill(false);
  for (let i = n - 1; i >= 0; i--) {
    if (!keep[i]) continue;
    const g = geoms[i]!;
    const placed: WreckChildSpawn[] = [];
    const integrity = new Map<number, number>();
    for (const pc of rec.pieces) {
      if (pc.node !== i) continue;
      const geom = g.find((x) => x.index === pc.piece);
      if (geom === undefined) continue;
      placed.push({ geom, x: pc.x, y: pc.y, vx: 0, vy: 0, angle: pc.angle, angvel: 0 });
      integrity.set(pc.piece, pc.integrity === WRECK_LINEAGE_UNBREAKABLE ? Number.POSITIVE_INFINITY : pc.integrity);
    }
    // The saved wear, not a fresh piece's.
    const h = { addPiece: (id: string, wreckId: number, entry: PieceKnock, f: string[]) => { entry.integrity = integrity.get(entry.index) ?? entry.integrity; host.addPiece(id, wreckId, entry, f); } };
    const ore = nodes[i]!.ore;
    const r = placed.length > 0 ? spawnWreckPieces(quiet, h, src, { ...(ore !== undefined ? { ore } : {}) }, placed, 0, serial[i]!, ids[i]!, like, fifo, '') : { ids: [], mass: 0 };
    spawned[i] = r;
    if (r.ids.length > 0) live[i] = true;
    if (live[i] && i > 0) live[nodes[i]!.parent] = true;
  }
  if (!live[0]) return null;

  // 3. The wrecks, parent before child (`addWreck` counts the children and
  //    hands the lineage root down).
  const added: Array<LiveWreck | null> = new Array<LiveWreck | null>(n).fill(null);
  const tick = d.serverTick();
  for (let i = 0; i < n; i++) {
    if (!live[i]) continue;
    const nd = nodes[i]!;
    const { deathTick: _cool, ...desc } = { ...descs[i]!, wreckId: ids[i]!, ...(i > 0 ? { parentWreck: ids[nd.parent]! } : {}) };
    const r = spawned[i]!;
    const ore = nd.ore;
    host.addWreck({
      desc, pieces: r.ids.length, ids: r.ids, mass: r.mass, holdUntil: tick,
      chain: { root: chainRoot, steps: nd.steps }, parent: i > 0 ? ids[nd.parent]! : 0, children: 0, src,
      ...(ore !== undefined ? { ore } : {}),
    }, i > 0 ? added[nd.parent]! : null);
    added[i] = s.wrecks.get(ids[i]!) ?? null;
  }
  return ids[0]!;
}

/** A restored piece's knock numbers: a ship wreck's from its kind (the
 *  death path's, at the kind's base max hull); a rock's none (rockCut.ts). */
function knockLike(kind: ReturnType<typeof wreckSourceOf>['ship'], rootGeom: ReadonlyArray<WreckPieceGeometry>): PieceKnock | null {
  if (kind === null) return null;
  const k = getShipKind(kind);
  const tuning = shipTuning(k);
  const profile = wreckSourceOf({ kindId: kind }).profile;
  let hullMass = 0;
  for (const g of rootGeom) hullMass += g.mass;
  return {
    mass: 0, impulsePerDamage: (hullMass * tuning.wreckKnockSpeed) / Math.max(1, k.maxHealth),
    maxDv: tuning.wreckKnockMax, spin: profile.spinScale, wakeDv: profile.knockWakeScale * tuning.wreckKnockMax,
    index: 0, integrity: 0, cx: 0, cy: 0, radius: 0, burn: null,
  };
}
