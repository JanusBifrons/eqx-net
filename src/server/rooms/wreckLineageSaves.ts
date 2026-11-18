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
 *  - STREAM (wreck fields 0b, owner Q3 "keep it all"): the battle lineages
 *    are a chunk source of the room's ONE streamer, like field hulls. A
 *    lineage is where its pieces are (no home chunk): once no piece has been
 *    in a needed chunk, on a tractor or in its crack hold for the linger, it
 *    is written and retired (`LineageUnloader`, shared with
 *    `WreckFieldSource`); its row stays, indexed by its pieces' chunks, and
 *    it comes back (`restoreLineage`) when a ship needs one of them, within
 *    the shared budget (`lineageUnits`) and the battle caps (one that would
 *    pass a cap waits). The battle FIFO eviction retires the evicted piece's
 *    whole lineage to its row (`evictPiece`) instead of deleting it, so the
 *    live cap bounds only what is near ships and nothing is lost. A room
 *    that does not stream (test rooms unless `battleWreckStreaming`) loads
 *    every row at boot and deletes on eviction, as before.
 *  - RESTORE (on approach, or boot when not streaming): each row is parsed
 *    (#3) at boot; a bad row, or one from
 *    another `FRACTURE_ALGO_VERSION`, is deleted with a `warn`. The tree is
 *    rebuilt with fresh u16 wreck ids and rewritten `parentWreck` links, its
 *    geometry resolved by the shared core resolver (the client's), and its
 *    live pieces spawned through the re-split / rock-cut piece spawn
 *    (`spawnWreckPieces` + `addWreck`) at their saved poses, at rest, with
 *    their saved integrity, no `deathTick` (drawn cool), asleep (the
 *    worker's `sleeping` spawn: FLAG_SLEEPING from step 1). The row keeps its
 *    serial, so later writes overwrite it.
 *
 * Restore, retire and flush are chunk, timer and dispose events: they
 * allocate. The streamer step's sweep allocates nothing in steady state.
 */
import { collectLineage, WRECK_LINEAGE_UNBREAKABLE, type WreckLineageDeps, type WreckLineageRecord } from './wreckLineageRecord.js';
import { lineageRowKey, type TerrainRecordStore } from '../db/terrainSql.js';
import { terrainRecordStoreFor } from '../db/PersistenceWorker.js';
import { FRACTURE_ALGO_VERSION } from '../../core/destruction/fractureHull.js';
import { rebuildWreckPieces, resolveChildWreckPieces, wreckDescriptorUsable } from '../../core/destruction/wreckDescriptorGeometry.js';
import type { WreckFractureInputs, WreckPieceGeometry } from '../../core/destruction/wreckPieceFrame.js';
import { wreckSourceOf } from '../../core/destruction/wreckSource.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import type { WreckDescriptor } from '../../shared-types/messages/wreckDescriptor.js';
import type { CapitalWreckDeps, LiveWreck, PieceKnock, WreckOrigin } from './capitalWreckTypes.js';
import { spawnWreckPieces, type WreckChildSpawn, type WreckPiecePose, type WreckResplitHost } from './wreckResplit.js';
import type { ChunkSource } from '../../core/terrain/chunkStreamer.js';
import { lineageChunks, lineageUnits, LineageUnloader, parseLineageJson } from './wreckLineageStream.js';
import { lineageRootOf } from './wreckLineage.js';

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

/** What `collectLineage` reads, over the wreck system's maps: one per saver
 *  (battle saves here, field hulls in `WreckFieldSource`). */
export function lineageRecordDeps(s: WreckLineageState): WreckLineageDeps {
  return {
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

/** A saved lineage that is not loaded: its record, the chunks its pieces lie
 *  in, its restore cost and FIFO class. */
interface SavedLineage { rec: WreckLineageRecord; chunks: number[]; units: number; capital: boolean }

/** What the battle source reads from the room (wreck fields 0b). */
export interface BattleWreckStreamDeps {
  /** A live piece's pose into `out`; false when it is gone. */
  piecePoseInto(id: string, out: WreckPiecePose): boolean;
  /** Is a piece on a tractor lease? Absent ⇒ never. */
  tractored?(id: string): boolean;
  /** Stream lineages (retire far ones, restore near ones, evict to rows)?
   *  False: every row comes back at boot and the cap deletes (test rooms
   *  that do not opt in, room option `battleWreckStreaming`). */
  streaming: boolean;
  /** Game ms no ship is near a lineage before it retires to its row. */
  lingerMs?: number;
}

/** Counters for tests and perf (counts only). */
export interface BattleWreckStats { saved: number; retired: number; restored: number; evicted: number; capWaits: number; unitsThisStep: number }

/** The default linger: the streamer's (`CutFieldStreamer`), as field hulls. */
const BATTLE_LINGER_MS = 10_000;

export class BattleWreckSaves implements ChunkSource {
  private readonly dirty = new Set<number>();
  /** Live lineage root wreck id → its row serial. */
  private readonly serials = new Map<number, number>();
  /** Saved lineages not loaded, by serial, and their serials by chunk. */
  private readonly rows = new Map<number, SavedLineage>();
  private readonly byChunk = new Map<number, number[]>();
  /** Live battle root → game ms a piece was last near (or it came). */
  private readonly lastNear = new Map<number, number>();
  private s: WreckLineageState | null = null;
  private deps: WreckLineageDeps | null = null;
  private readonly unloader: LineageUnloader;
  /** True while this source removes pieces (their touches are its own). */
  private retiring = false;
  private nowMs = 0;
  readonly stats: BattleWreckStats = { saved: 0, retired: 0, restored: 0, evicted: 0, capWaits: 0, unitsThisStep: 0 };

  constructor(
    /** The room's wreck maps; null until the wreck system exists (the
     *  streaming host is built before it). */
    private readonly state: () => WreckLineageState | null,
    private readonly store: TerrainRecordStore,
    private readonly sd: BattleWreckStreamDeps,
  ) {
    this.unloader = new LineageUnloader(sd);
  }

  private st(): WreckLineageState | null {
    if (this.s === null) { this.s = this.state(); if (this.s !== null) this.deps = lineageRecordDeps(this.s); }
    return this.s;
  }

  /** Lineage `root` changed (`CapitalWreckDeps.lineageTouched`). */
  touch(root: number): void { if (!this.retiring) this.dirty.add(root); }

  /** Saved lineages not loaded now (rows only). Tests and perf. */
  savedUnloaded(): number { return this.rows.size; }

  /** Write the dirty lineages, plus every lineage with an awake piece
   *  (`all`: every live lineage, the room's dispose). */
  flush(all: boolean): void {
    const s = this.st();
    if (s === null) return;
    const { wrecks, pieceWreck, knock, d } = s;
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

  /** Write lineage `root`'s row (no piece left: delete it). Returns the
   *  record written, or null. */
  private write(root: number): WreckLineageRecord | null {
    // A field lineage is the wreck field's (WreckFieldSource), never a battle row.
    if (this.s!.wrecks.get(root)?.origin === 'field') return null;
    const rec = collectLineage(root, this.deps!);
    let serial = this.serials.get(root);
    if (rec === null || rec.pieces.length === 0) {
      // Fully salvaged: the row goes.
      if (serial !== undefined) this.store.deleteRecord(lineageRowKey(serial));
      this.serials.delete(root);
      return null;
    }
    if (serial === undefined) { serial = this.store.nextLineageSerial(); this.serials.set(root, serial); }
    this.store.putLineage(serial, JSON.stringify(rec));
    return rec;
  }

  /** Room boot: read every saved row (a bad one is dropped with a warning).
   *  Streaming: index them by the chunks their pieces lie in; each loads
   *  when a ship comes near (`step`). Not streaming: all come back now.
   *  Returns the rows kept. */
  loadRows(): number {
    const s = this.st();
    if (s === null) return 0;
    let n = 0;
    for (const { serial, json } of this.store.lineages()) {
      const { rec, algo } = parseLineageJson(json);
      if (rec === null) {
        this.store.warn({ sectorKey: this.store.sectorKey, serial, fractureAlgo: algo, want: FRACTURE_ALGO_VERSION },
          algo !== undefined && algo !== FRACTURE_ALGO_VERSION ? 'battle wreck lineage from another fracture version, dropped' : 'battle wreck lineage row unreadable, dropped');
        this.store.deleteRecord(lineageRowKey(serial));
        continue;
      }
      if (this.sd.streaming) { this.index(serial, rec); n++; continue; }
      if (this.restoreRow(s, serial, rec)) n++;
    }
    if (!this.sd.streaming) { s.host.enforceCap(true); s.host.enforceCap(false); }
    return n;
  }

  /** Bring saved lineage `serial` back (`restoreLineage`: fresh ids, saved
   *  poses); a row that does not resolve is dropped with a warning. */
  private restoreRow(s: WreckLineageState, serial: number, rec: WreckLineageRecord): boolean {
    const root = restoreLineage(s, rec);
    if (root === null) {
      this.store.warn({ sectorKey: this.store.sectorKey, serial }, 'battle wreck lineage did not resolve or spawn, dropped');
      this.store.deleteRecord(lineageRowKey(serial));
      return false;
    }
    this.serials.set(root, serial);
    this.lastNear.set(root, this.nowMs);
    return true;
  }

  /** Keep saved lineage `serial` as a row, found by its pieces' chunks. */
  private index(serial: number, rec: WreckLineageRecord): void {
    const chunks = lineageChunks(rec);
    const capital = wreckSourceOf(rootInputs(rec.nodes[0]!.desc as WreckDescriptor)).profile.id === 'capital';
    this.rows.set(serial, { rec, chunks, units: lineageUnits(rec), capital });
    for (const k of chunks) {
      let list = this.byChunk.get(k);
      if (list === undefined) this.byChunk.set(k, list = []);
      list.push(serial);
    }
  }

  private unindex(serial: number, row: SavedLineage): void {
    this.rows.delete(serial);
    for (const k of row.chunks) {
      const list = this.byChunk.get(k);
      if (list === undefined) continue;
      const i = list.indexOf(serial);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.byChunk.delete(k);
    }
  }

  /** The battle lineages as a chunk source of the room's ONE streamer (wreck
   *  fields 0b): a saved lineage with a piece in a needed chunk comes back
   *  (within the shared budget and the battle caps: one that would pass a
   *  cap waits, so a restore never evicts); a live one with no piece near
   *  (needed chunk, tractor, crack hold) for the linger retires to its row.
   *  Steady state allocates nothing (#14); a restore or retire is a chunk
   *  event. */
  step(needed: ReadonlySet<number>, budget: number, now: number): number {
    this.nowMs = now;
    const s = this.sd.streaming ? this.st() : null;
    if (s === null) return 0;
    let spent = 0;
    if (this.byChunk.size > 0) {
      for (const key of needed) {
        const list = this.byChunk.get(key);
        if (list === undefined) continue;
        for (let i = list.length - 1; i >= 0; i--) {
          const serial = list[i]!;
          const row = this.rows.get(serial);
          if (row === undefined || budget <= 0 || (spent > 0 && spent + row.units > budget)) continue;
          if (s.host.fifo(row.capital, 'battle').length + row.rec.pieces.length > s.host.cap(row.capital, 'battle')) { this.stats.capWaits++; continue; }
          spent += row.units;
          this.unindex(serial, row);
          if (this.restoreRow(s, serial, row.rec)) this.stats.restored++;
          if (i > list.length) i = list.length;
        }
      }
    }
    this.sweep(s, needed, now);
    this.stats.unitsThisStep = spent;
    return Math.min(spent, budget);
  }

  /** Mark every live battle lineage with a piece near (one pass over the
   *  wrecks), then retire the ones none has been near for the linger. */
  private sweep(s: WreckLineageState, needed: ReadonlySet<number>, now: number): void {
    const tick = s.d.serverTick();
    for (const w of s.wrecks.values()) {
      if (w.origin !== 'battle' || w.pieces <= 0) continue;
      if (tick < w.holdUntil || this.unloader.wreckNear(s, w, needed) || !this.lastNear.has(w.root)) this.lastNear.set(w.root, now);
    }
    const linger = this.sd.lingerMs ?? BATTLE_LINGER_MS;
    for (const [root, t] of this.lastNear) {
      const w = s.wrecks.get(root);
      if (w === undefined || w.root !== root || w.origin !== 'battle') { this.lastNear.delete(root); continue; }
      if (now - t >= linger) { this.retireRoot(s, root); this.stats.retired++; }
    }
  }

  /** Lineage `root` to its row (written now), then every piece out. */
  private retireRoot(s: WreckLineageState, root: number): void {
    const rec = this.write(root);
    const serial = this.serials.get(root);
    this.retiring = true;
    try { this.unloader.retire(s, root); } finally { this.retiring = false; }
    this.dirty.delete(root);
    this.lastNear.delete(root);
    this.serials.delete(root);
    if (rec !== null && serial !== undefined) { this.index(serial, rec); this.stats.saved++; }
  }

  /** Battle FIFO eviction (`CapitalWreckDeps.evictRetire`): streaming, the
   *  evicted piece's whole lineage retires to its row instead of being
   *  deleted, so nothing is lost. False (not streaming): delete as before. */
  evictPiece(id: string): boolean {
    const s = this.sd.streaming && !this.retiring ? this.st() : null;
    if (s === null) return false;
    const root = lineageRootOf(s.wrecks, s.pieceWreck, id);
    if (root === null || s.wrecks.get(root)?.origin !== 'battle') return false;
    this.retireRoot(s, root);
    this.stats.evicted++;
    return true;
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

/** A saved lineage's geometry: each node's descriptor (provisional id =
 *  local index + 1) and, for a node with a live piece or a descendant of
 *  one (`keep`), its pieces through the shared resolver exactly as a client
 *  would (#15); null for the rest. Null when the root has no live piece or
 *  a kept node does not resolve. Restore, and placement's view of an
 *  unloaded field hull (`WreckFieldSource.dormantObstacles`). Allocates. */
export function resolveLineageGeometry(rec: WreckLineageRecord): { descs: WreckDescriptor[]; geoms: Array<WreckPieceGeometry[] | null>; keep: boolean[] } | null {
  const nodes = rec.nodes;
  const n = nodes.length;
  // Keep a node with a live piece, and every ancestor of one.
  const keep: boolean[] = new Array<boolean>(n).fill(false);
  for (const pc of rec.pieces) keep[pc.node] = true;
  for (let i = n - 1; i > 0; i--) if (keep[i]) keep[nodes[i]!.parent] = true;
  if (!keep[0]) return null;
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
  return { descs, geoms, keep };
}

/**
 * Rebuild one saved lineage. Returns its new root wreck id, or null when
 * nothing came back (geometry did not resolve, or no piece could spawn);
 * then nothing is left behind. `origin`: a battle lineage (the evicting
 * FIFOs) or a wreck-field hull's (the field list, wreck fields slice 4).
 */
export function restoreLineage(s: WreckLineageState, rec: WreckLineageRecord, origin: WreckOrigin = 'battle'): number | null {
  const nodes = rec.nodes;
  const n = nodes.length;
  // 1. Descriptors with provisional ids, resolved as a client would (#15).
  const resolved = resolveLineageGeometry(rec);
  if (resolved === null) return null;
  const { descs, geoms, keep } = resolved;

  // 2. Fresh u16 ids and piece serials, then the pieces (children first, so a
  //    node whose pieces all failed to spawn and has no child is never added).
  const { host, d } = s;
  // Restored pieces are at rest: they spawn asleep (`sleeping`, no awake window).
  const quiet: CapitalWreckDeps = { ...d, pieceSplit: undefined, dropSalvage: undefined, spawnPiece: (spec) => d.spawnPiece({ ...spec, sleeping: true }) };
  const chainRoot = rootInputs(descs[0]!);
  const src = wreckSourceOf(chainRoot);
  const fifo = host.fifo(src.profile.id === 'capital', origin);
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
      chain: { root: chainRoot, steps: nd.steps }, parent: i > 0 ? ids[nd.parent]! : 0, children: 0, src, origin,
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
