/**
 * Wreck fields slice 3b (plan wreck-fields-plan.md, review 2 R7 / review 3;
 * docs/architecture/macro-terrain.md "F3"): an old battlefield's hulls as a
 * chunk source of the room's ONE streamer (`CutFieldSubsystem`'s
 * `CutFieldStreamer`: one timer, one ship scan, one work budget).
 *
 * Load: for each chunk the streamer needs, each hull whose centre lies in it
 * (`hullsInChunk`) spawns through THE wreck spawn path
 * (`CapitalWreckSubsystem.spawnWreck`): origin `field` (the non-evicting
 * field list), not held, cool (no `deathTick`), asleep, owner = the hull's
 * faction (ships are owned or scrap), broken by `wreckFieldHullFracture`. A
 * hull that would take the field past its cap (`FIELD_LIVE_CAP`) waits.
 * Each hull costs `fieldHullUnits(kind)` of the shared budget (measured
 * against a rock chunk cut, never invented).
 *
 * Retire: once a hull's HOME chunk has gone unneeded for the linger, an
 * UNTOUCHED hull (no piece hit, split, gone, moved or on a tractor) is
 * removed through `dropPiece` and comes back from the seed (or its row) on
 * re-entry. A TOUCHED hull (slice 4) unloads by where its pieces are: it
 * stays loaded while any live piece of its lineage lies in a chunk the
 * streamer needs, or is on a tractor; once none has been for the linger,
 * the whole lineage (`forEachLineagePiece`) goes through `dropPiece` and
 * ONE lineage row is written (`collectLineage`, the battle wrecks' row
 * shape) to `terrain_records`, partition `<sectorKey>|wrecks:<seed>`,
 * `rock_key` = the hull key (`rockKey(cx, cy, hullSlot)` of its home
 * chunk), `layout_version` = `WRECK_FIELD_ROW_VERSION`. A hull with no live
 * piece left writes a `consumed` row (as a mined-out rock), at once.
 * Reload: a hull with a row spawns from it through THE battle restore path
 * (`restoreLineage`: fresh ids, rewritten parent links, asleep, cool) at
 * the stored poses, never also from the seed; a consumed row spawns
 * nothing. Rows load once with `loadRecords` (a stale version is ignored
 * with a warning). A hull key is live at most once: no double spawn. While
 * its home chunk is needed a hull never unloads (no load/unload thrash).
 *
 * #14: steady state (no chunk to load or retire) allocates nothing; a load
 * is generation-time work (the fracture allocates), bounded by the budget;
 * the pending-unload sweep reads poses through made-once callbacks.
 */
import { chunkKey, chunkKeyX, chunkKeyY, type ChunkSource } from '../../core/terrain/chunkStreamer.js';
import { hullsInChunk, wreckFieldHullFracture, WRECK_FIELD, WRECK_FIELD_VERSION, type WreckField, type WreckFieldHull, type WreckFieldOpts } from '../../core/terrain/wreckFieldLayout.js';
import { FRACTURE_ALGO_VERSION } from '../../core/destruction/fractureHull.js';
import { loadRecords, type RockRecordStore } from '../db/terrainSql.js';
import { collectLineage, parseLineageRecord, type WreckLineageDeps, type WreckLineageRecord } from './wreckLineageRecord.js';
import { lineageRecordDeps, resolveLineageGeometry, restoreLineage } from './wreckLineageSaves.js';
import type { GridObstacle, ObstacleBox } from '../../core/structures/Grid.js';
import { buildWreckPieces, type WreckPieceSpec } from '../../core/destruction/wreckPieces.js';
import { CHUNK_SIZE } from '../../core/terrain/fieldLayout.js';
import { shipShapeScale } from '../../core/geometry/shipHullOutline.js';
import { Rng, fnvMixU32 } from '../../core/random/rng.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import type { WreckFractureInputs } from '../../core/destruction/wreckPieceFrame.js';
import type { CapitalWreckSubsystem, WreckPiecePose } from './CapitalWreckSubsystem.js';

/** Work units (one unit = one rock chunk cut, `CutFieldStreamer`) a field
 *  hull's fracture + spawn costs, by size class: measured by
 *  `WreckFieldSource.test.ts` "budget units" (desktop p50 hull load ÷ p50
 *  rock chunk cut, rounded up to a tenth). Measured 2026-11-17: a chunk
 *  inside the ring 2.0-2.2 ms; capital 0.49-0.61, subcap 0.13, fighter
 *  0.07-0.09 units. */
export const FIELD_HULL_UNITS = { capital: 0.7, subcap: 0.2, fighter: 0.1 } as const;

/** A field hull row's `layout_version`: the layout's and the fracture's
 *  versions, so a bump of either leaves old rows ignored with a warning. */
export const WRECK_FIELD_ROW_VERSION = WRECK_FIELD_VERSION * 256 + FRACTURE_ALGO_VERSION;

/** A field hull's budget cost (`FIELD_HULL_UNITS` by its kind's class). */
export function fieldHullUnits(kindId: ShipKindId): number {
  const k = getShipKind(kindId);
  if (k.sizeClass === 'capital') return FIELD_HULL_UNITS.capital;
  return k.radius >= WRECK_FIELD.subcapMinRadius ? FIELD_HULL_UNITS.subcap : FIELD_HULL_UNITS.fighter;
}

/** Seconds of break-up drift a field hull's pieces have had (seeded per
 *  hull): a few seconds of their parting kicks, so the cuts read open. */
const DRIFT_S: readonly [number, number] = [1, 3];
/** The most a piece's centre drifts: a share of the hull's free footprint
 *  margin (`footprintMul` − 1 radii), and never past a quarter chunk. */
const DRIFT_MARGIN_SHARE = 0.5;

/** A field hull's pieces at rest where they drifted to: its fracture
 *  (`wreckFieldHullFracture`), broken by `buildWreckPieces` at the hull's
 *  pose, each piece moved along its parting kick for a seeded drift time and
 *  left still (zero velocity and kick). Generation-time; allocates. */
export function fieldHullPieces(hull: WreckFieldHull): { pieces: WreckPieceSpec[]; fracture: WreckFractureInputs } {
  const f = wreckFieldHullFracture(hull);
  const kind = getShipKind(hull.kindId);
  const s = shipShapeScale(kind), c = Math.cos(hull.angle), sn = Math.sin(hull.angle);
  // The kill point: the hull's 1x Pixi-up frame → world (buildWreckPieces' frame).
  const mx = f.killX * s, my = -f.killY * s;
  const pose = { x: hull.x, y: hull.y, vx: 0, vy: 0, angle: hull.angle, angvel: 0 };
  const { pieces, fracture } = buildWreckPieces({
    kindId: hull.kindId, pose, killWorld: { x: hull.x + mx * c - my * sn, y: hull.y + mx * sn + my * c }, attackerWorld: null,
    seed: f.seed, killBlowDamage: f.killBlowDamage, recentDamageRate: f.recentDamageRate,
  });
  let vmax = 0;
  for (const p of pieces) vmax = Math.max(vmax, Math.hypot(p.kickVx, p.kickVy));
  const r = new Rng(fnvMixU32(hull.seed, 0xd71f));
  const want = DRIFT_S[0] + (DRIFT_S[1] - DRIFT_S[0]) * (r.u32() / 4294967296);
  const reach = Math.min((WRECK_FIELD.footprintMul - 1) * kind.radius * DRIFT_MARGIN_SHARE, CHUNK_SIZE / 4);
  const t = vmax > 0 ? Math.min(want, reach / vmax) : 0;
  for (const p of pieces) {
    p.x += p.kickVx * t; p.y += p.kickVy * t; p.angle += p.kickAngvel * t;
    p.vx = 0; p.vy = 0; p.angvel = 0; p.kickVx = 0; p.kickVy = 0; p.kickAngvel = 0;
  }
  return { pieces, fracture };
}

/** The room option `wreckField` (`SectorRoom`): where the battlefield lies,
 *  its seed, the two sides that fought there (faction ids) and, optionally,
 *  its own open clearings (galaxy sectors: every pocket; else the cut
 *  field's). */
export type WreckFieldRoomOpts = Pick<WreckFieldOpts, 'seed' | 'x' | 'y' | 'sides' | 'clearings'> & {
  /** Dev look flag (wreck fields 9, owner Q4 stills): seed hulls spawn
   *  freshly dead (a `deathTick` at load: hot cut edges that cool on the
   *  normal schedule) instead of cool. Off by default; dev room
   *  `wreck-field-test-fresh` only. */
  fresh?: boolean;
};

/** A loaded field hull: its lineage root, its pieces as spawned (ids, rest
 *  poses), and whether anything touched it since. */
interface LiveHull {
  hull: WreckFieldHull;
  root: number;
  ids: string[];
  x: number[];
  y: number[];
  a: number[];
  touched: boolean;
  /** Game ms a piece was last in a needed chunk or on a tractor (pending
   *  unload only). */
  lastNearMs: number;
}

/** A hull's saved row (`terrain_records`): its lineage JSON, or consumed. */
interface HullRow { consumed: boolean; json: string | null }
const CONSUMED_ROW: HullRow = { consumed: true, json: null };

/** A chunk with hulls the streamer has needed: when it last was. */
interface FieldChunk { lastNeededMs: number }

export interface WreckFieldSourceDeps {
  /** The room's wreck system; built after the streaming host, so read late.
   *  Undefined (wrecks off) ⇒ the source loads nothing. */
  wrecks(): CapitalWreckSubsystem | undefined;
  /** A live piece's pose into `out`; false when it is gone. */
  piecePoseInto(id: string, out: WreckPiecePose): boolean;
  /** Is a live piece awake (off FLAG_SLEEPING)? */
  pieceAwake(id: string): boolean;
  /** Is a piece on a tractor lease? Absent ⇒ never. */
  tractored?(id: string): boolean;
  /** The field's row partition (`<sectorKey>|wrecks:<seed>`); absent (a
   *  room that saves no sector) ⇒ rows live in memory for the room only. */
  records?: RockRecordStore;
  /** Dev look flag (`WreckFieldRoomOpts.fresh`): seed hulls spawn with a
   *  `deathTick` (drawn just killed) instead of cool. Absent: cool. */
  fresh?: boolean;
  /** Sampled warning sink (pino `warn`). */
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** A piece left closer than this to where it spawned (world u / rad) has not
 *  moved (as `CutFieldSubsystem`'s rocks). */
const MOVED_EPS = 0.5;
const MOVED_EPS_ANGLE = 1e-3;
/** Warn on the first cap refusal, then every this many. */
const CAP_WARN_EVERY = 100;
const TWO_PI = Math.PI * 2;
/** A hull the cap refused is tried again after this long (game ms). */
const CAP_RETRY_MS = 2_000;

/** Counters for tests and perf (counts only). */
export interface WreckFieldStats {
  hullsLive: number;
  hullsSpawned: number;
  hullsRetired: number;
  /** Hulls a load left waiting because the field was at its cap. */
  capRefusals: number;
  /** Touched hulls unloaded into a lineage row. */
  hullsUnloaded: number;
  /** Hulls spawned from a row (not the seed). */
  hullsRestored: number;
  /** Hulls whose every piece went (consumed rows written). */
  hullsConsumed: number;
  /** Work units spent by the last step. */
  unitsThisStep: number;
}

export class WreckFieldSource implements ChunkSource {
  /** Loaded hulls by hull key (`rockKey`): a key is live at most once. */
  private readonly live = new Map<number, LiveHull>();
  /** Lineage root → its loaded hull (hits and splits mark it touched). */
  private readonly byRoot = new Map<number, LiveHull>();
  /** Chunks with hulls the streamer has needed, by `chunkKey`. */
  private readonly chunks = new Map<number, FieldChunk>();
  private readonly freeChunks: FieldChunk[] = [];
  /** Hull key → game ms before which a cap-refused hull is not retried. */
  private readonly waitUntil = new Map<number, number>();
  /** The hull being spawned (its first `touched` call names its root). */
  private spawning: LiveHull | null = null;
  /** True while this source removes pieces (their touches are its own). */
  private retiring = false;
  private readonly pose: WreckPiecePose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  readonly stats: WreckFieldStats = { hullsLive: 0, hullsSpawned: 0, hullsRetired: 0, capRefusals: 0, hullsUnloaded: 0, hullsRestored: 0, hullsConsumed: 0, unitsThisStep: 0 };
  /** Saved hull rows by hull key (loaded once; kept current as rows go out). */
  private readonly rows = new Map<number, HullRow>();
  /** Touched hulls whose home chunk's linger ran out: they unload once no
   *  piece is near (in a needed chunk or on a tractor) for the linger. */
  private readonly pending = new Set<LiveHull>();
  /** Touched hulls to check for a lineage with no piece left (consumed). */
  private readonly check = new Set<LiveHull>();
  /** The largest hull footprint: how far past a box a hull's home chunk
   *  can lie and still reach it (`dormantObstacles`). */
  private readonly reach: number;
  /** Scratch for the made-once lineage visitors (#14). */
  private readonly scratchIds: string[] = [];
  private sweepNeeded: ReadonlySet<number> = new Set<number>();
  private sweepNear = false;
  private nowMs = 0;
  private recDeps: WreckLineageDeps | null = null;
  /** Is lineage piece `id` near (in a needed chunk, or on a tractor)? */
  private readonly visitNear = (id: string): void => {
    if (this.sweepNear) return;
    if (this.d.tractored?.(id) === true) { this.sweepNear = true; return; }
    if (this.d.piecePoseInto(id, this.pose)
      && this.sweepNeeded.has(chunkKey(Math.floor(this.pose.x / CHUNK_SIZE), Math.floor(this.pose.y / CHUNK_SIZE)))) this.sweepNear = true;
  };
  private readonly collectId = (id: string): void => { this.scratchIds.push(id); };

  constructor(
    readonly field: WreckField,
    private readonly d: WreckFieldSourceDeps,
    private readonly lingerMs = 10_000,
  ) {
    let reach = 0;
    for (const h of field.hulls) if (h.footprint > reach) reach = h.footprint;
    this.reach = reach;
    if (d.records !== undefined) {
      for (const r of loadRecords(d.records, WRECK_FIELD_ROW_VERSION)) {
        this.rows.set(r.rockKey, r.consumed ? CONSUMED_ROW : { consumed: false, json: r.lineage });
      }
    }
  }

  /** Lineage `root` changed (`CapitalWreckDeps.lineageTouched`): a spawn
   *  names its root; anything later (a hit, a split, a piece gone) marks
   *  the hull touched (and checked for a lineage left with no piece). No
   *  allocation. */
  touched(root: number): void {
    if (this.spawning !== null) { if (this.spawning.root === 0) this.spawning.root = root; return; }
    if (this.retiring) return;
    const h = this.byRoot.get(root);
    if (h !== undefined) { h.touched = true; this.check.add(h); }
  }

  /** Hull `key`'s saved row: 'consumed', 'lineage', or null (none). Tests. */
  rowOf(key: number): 'consumed' | 'lineage' | null {
    const r = this.rows.get(key);
    return r === undefined ? null : r.consumed ? 'consumed' : 'lineage';
  }

  /** The loaded hull key holding lineage `root`, or null. Tests. */
  hullKeyOf(root: number): number | null { return this.byRoot.get(root)?.hull.key ?? null; }

  /** Is hull `key` loaded? */
  isLive(key: number): boolean { return this.live.has(key); }

  /** Live field pieces (the wreck system's field list). Tests and perf. */
  livePieces(): number { return this.d.wrecks()?.liveFieldCount() ?? 0; }

  /** The loaded hulls' piece ids as spawned, into `out` (tests). */
  pieceIds(out: string[] = []): string[] {
    for (const lh of this.live.values()) for (const id of lh.ids) out.push(id);
    return out;
  }

  step(needed: ReadonlySet<number>, budget: number, now: number): number {
    let spent = 0;
    this.nowMs = now;
    const wrecks = this.d.wrecks();
    if (wrecks !== undefined) {
      for (const key of needed) {
        const cx = chunkKeyX(key), cy = chunkKeyY(key);
        const hulls = hullsInChunk(this.field, cx, cy);
        if (hulls.length === 0) continue;
        let ch = this.chunks.get(key);
        if (ch === undefined) { ch = this.freeChunks.pop() ?? { lastNeededMs: 0 }; this.chunks.set(key, ch); }
        ch.lastNeededMs = now;
        for (let i = 0; i < hulls.length; i++) {
          const h = hulls[i]!;
          const lh = this.live.get(h.key);
          if (lh !== undefined) { this.pending.delete(lh); continue; } // home needed again: not leaving
          if (this.rows.get(h.key)?.consumed === true || (this.waitUntil.get(h.key) ?? 0) > now) continue;
          const cost = fieldHullUnits(h.kindId);
          // The first load of a step always goes (a hull dearer than the
          // whole budget would otherwise never load); the rest fit the budget.
          if (spent > 0 && spent + cost > budget) continue;
          if (budget <= 0) continue;
          spent += cost;
          this.load(wrecks, h, now);
        }
      }
    }
    this.retireUnneeded(needed, now, wrecks);
    if (wrecks !== undefined) { this.sweepConsumed(wrecks); this.sweepPending(needed, now, wrecks); }
    this.stats.unitsThisStep = spent;
    this.stats.hullsLive = this.live.size;
    return Math.min(spent, budget);
  }

  /** Spawn hull `h` asleep (from its row when it has one, else the seed),
   *  unless the field would pass its cap. */
  private load(wrecks: CapitalWreckSubsystem, h: WreckFieldHull, now: number): void {
    const rec = this.savedLineage(h);
    const seeded = rec === null ? fieldHullPieces(h) : null;
    const count = rec !== null ? rec.pieces.length : seeded!.pieces.length;
    const host = wrecks.lineageState().host;
    if (wrecks.liveFieldCount() + count > host.cap(false, 'field')) {
      if (this.stats.capRefusals++ % CAP_WARN_EVERY === 0) {
        this.d.warn({ hullKey: h.key, kind: h.kindId, pieces: count, fieldLive: wrecks.liveFieldCount(), refusals: this.stats.capRefusals }, 'wreck field at its live cap: hull waits');
      }
      this.waitUntil.set(h.key, now + CAP_RETRY_MS);
      return;
    }
    this.waitUntil.delete(h.key);
    if (rec !== null && this.restore(wrecks, h, rec)) return;
    const { pieces, fracture } = seeded ?? fieldHullPieces(h);
    const lh: LiveHull = { hull: h, root: 0, ids: [], x: [], y: [], a: [], touched: false, lastNearMs: 0 };
    this.spawning = lh;
    let n: number;
    try {
      n = wrecks.spawnWreck(h.kindId, `field:${h.key}`, pieces, fracture, getShipKind(h.kindId).maxHealth, h.angle,
        { held: false, origin: 'field', sleeping: true, cool: this.d.fresh !== true, owner: h.owner });
    } finally { this.spawning = null; }
    if (n === 0 || lh.root === 0) return;
    // Its pieces as spawned, in spawn order (pieces carry their index).
    const knock = wrecks.lineageState().knock;
    wrecks.forEachLineagePiece(lh.root, (id) => {
      const idx = knock.get(id)?.index ?? -1;
      const p = pieces.find((q) => q.index === idx);
      if (p === undefined) return;
      lh.ids.push(id); lh.x.push(p.x); lh.y.push(p.y); lh.a.push(p.angle);
    });
    this.live.set(h.key, lh);
    this.byRoot.set(lh.root, lh);
    this.stats.hullsSpawned++;
  }

  /** Hull `h`'s saved lineage, or null (no row, or a row that does not
   *  parse: warned and forgotten, so the seed brings the hull back). */
  private savedLineage(h: WreckFieldHull): WreckLineageRecord | null {
    const row = this.rows.get(h.key);
    if (row === undefined || row.json === null) return null;
    let raw: unknown;
    try { raw = JSON.parse(row.json); } catch { raw = undefined; }
    const rec = raw === undefined ? null : parseLineageRecord(raw);
    if (rec === null) {
      this.d.warn({ hullKey: h.key, fractureAlgo: (raw as { fractureAlgo?: unknown } | undefined)?.fractureAlgo, want: FRACTURE_ALGO_VERSION }, 'wreck field hull row unreadable: seed hull instead');
      this.rows.delete(h.key);
    }
    return rec;
  }

  /** Spawn hull `h` from its saved lineage through THE battle restore path
   *  (`restoreLineage`, origin `field`), recording each piece as spawned.
   *  False when nothing came back (warned; the seed spawns instead). */
  private restore(wrecks: CapitalWreckSubsystem, h: WreckFieldHull, rec: WreckLineageRecord): boolean {
    const s = wrecks.lineageState();
    const lh: LiveHull = { hull: h, root: 0, ids: [], x: [], y: [], a: [], touched: false, lastNearMs: 0 };
    const spawnPiece = s.d.spawnPiece;
    const d = { ...s.d, spawnPiece: (spec: Parameters<typeof spawnPiece>[0]): boolean => {
      const ok = spawnPiece(spec);
      if (ok) { lh.ids.push(spec.id); lh.x.push(spec.x); lh.y.push(spec.y); lh.a.push(spec.angle); }
      return ok;
    } };
    this.spawning = lh;
    let root: number | null;
    try { root = restoreLineage({ ...s, d }, rec, 'field'); } finally { this.spawning = null; }
    if (root === null) {
      this.d.warn({ hullKey: h.key }, 'wreck field hull row did not resolve or spawn: seed hull instead');
      this.rows.delete(h.key);
      return false;
    }
    lh.root = root;
    this.live.set(h.key, lh);
    this.byRoot.set(root, lh);
    this.stats.hullsSpawned++;
    this.stats.hullsRestored++;
    return true;
  }

  /** Write hull `key`'s row: its lineage, or `consumed` (`rec` null or
   *  with no piece). A chunk event; allocates. */
  private writeRow(key: number, rec: WreckLineageRecord | null): void {
    const json = rec !== null && rec.pieces.length > 0 ? JSON.stringify(rec) : null;
    this.rows.set(key, json === null ? CONSUMED_ROW : { consumed: false, json });
    const store = this.d.records;
    store?.put({
      type: 'TERRAIN_RECORD_PUT', sectorKey: store.sectorKey, rockKey: key, layoutVersion: WRECK_FIELD_ROW_VERSION,
      pool: null, consumed: json === null, pose: null, lineage: json, ts: this.nowMs,
    });
  }

  /** Lineage `lh` as a row, from the live wreck maps. */
  private collect(wrecks: CapitalWreckSubsystem, lh: LiveHull): WreckLineageRecord | null {
    this.recDeps ??= lineageRecordDeps(wrecks.lineageState());
    return collectLineage(lh.root, this.recDeps);
  }

  /** Forget loaded hull `lh` (its pieces are already gone). */
  private forget(lh: LiveHull): void {
    this.live.delete(lh.hull.key);
    this.byRoot.delete(lh.root);
    this.pending.delete(lh);
    this.check.delete(lh);
  }

  /** Touched hulls whose lineage has no wreck left: consumed rows, at once
   *  (else the seed would bring them back). */
  private sweepConsumed(wrecks: CapitalWreckSubsystem): void {
    if (this.check.size === 0) return;
    const all = wrecks.lineageState().wrecks;
    for (const lh of this.check) {
      if (all.has(lh.root)) continue;
      this.writeRow(lh.hull.key, null);
      this.forget(lh);
      this.stats.hullsConsumed++;
    }
    this.check.clear();
  }

  /** Pending touched hulls: a piece in a needed chunk or on a tractor keeps
   *  the whole lineage; none for the linger ⇒ one row, then every piece
   *  through `dropPiece`. */
  private sweepPending(needed: ReadonlySet<number>, now: number, wrecks: CapitalWreckSubsystem): void {
    if (this.pending.size === 0) return;
    this.sweepNeeded = needed;
    for (const lh of this.pending) {
      this.sweepNear = false;
      wrecks.forEachLineagePiece(lh.root, this.visitNear);
      if (this.sweepNear) { lh.lastNearMs = now; continue; }
      if (now - lh.lastNearMs < this.lingerMs) continue;
      this.writeRow(lh.hull.key, this.collect(wrecks, lh));
      this.retireLineage(wrecks, lh);
      this.stats.hullsUnloaded++;
    }
  }

  /** Every live piece of `lh`'s lineage out through `dropPiece` (its
   *  ancestors retire with their last piece), then forget it. */
  private retireLineage(wrecks: CapitalWreckSubsystem, lh: LiveHull): void {
    const ids = this.scratchIds;
    ids.length = 0;
    wrecks.forEachLineagePiece(lh.root, this.collectId);
    this.retiring = true;
    try { for (let j = 0; j < ids.length; j++) wrecks.retireFieldPiece(ids[j]!); } finally { this.retiring = false; }
    ids.length = 0;
    this.forget(lh);
  }

  /** Room dispose: every touched loaded hull's row, so a restart brings it
   *  back as it is (the pieces stay; they go with the world). */
  flushAll(): void {
    const wrecks = this.d.wrecks();
    if (wrecks === undefined) return;
    this.sweepConsumed(wrecks);
    for (const lh of this.live.values()) if (this.isTouched(lh)) this.writeRow(lh.hull.key, this.collect(wrecks, lh));
  }

  /** Has anything touched hull `lh` (a hit, split or lost piece; a piece
   *  moved, awake or on a tractor)? A chunk event (reads each piece's pose). */
  private isTouched(lh: LiveHull): boolean {
    if (lh.touched) return true;
    for (let i = 0; i < lh.ids.length; i++) {
      const id = lh.ids[i]!;
      if (!this.d.piecePoseInto(id, this.pose)) return true;
      if (this.d.pieceAwake(id) || this.d.tractored?.(id) === true) return true;
      // The SAB angle is wrapped; the spawn angle may not be.
      const d = this.pose.angle - lh.a[i]!, da = Math.abs(d - TWO_PI * Math.round(d / TWO_PI));
      if (Math.hypot(this.pose.x - lh.x[i]!, this.pose.y - lh.y[i]!) >= MOVED_EPS || da >= MOVED_EPS_ANGLE) return true;
    }
    return false;
  }

  /** Chunks unneeded for the linger: retire their untouched hulls; touched
   *  ones go pending (they unload by where their pieces are). */
  private retireUnneeded(needed: ReadonlySet<number>, now: number, wrecks: CapitalWreckSubsystem | undefined): void {
    for (const [key, ch] of this.chunks) {
      if (needed.has(key) || now - ch.lastNeededMs < this.lingerMs) continue;
      this.chunks.delete(key);
      this.freeChunks.push(ch);
      const hulls = hullsInChunk(this.field, chunkKeyX(key), chunkKeyY(key));
      for (let i = 0; i < hulls.length; i++) {
        const lh = this.live.get(hulls[i]!.key);
        if (lh === undefined || wrecks === undefined) continue;
        if (this.isTouched(lh)) { lh.touched = true; lh.lastNearMs = ch.lastNeededMs; this.pending.add(lh); continue; }
        this.retiring = true;
        try { for (let j = 0; j < lh.ids.length; j++) wrecks.retireFieldPiece(lh.ids[j]!); } finally { this.retiring = false; }
        this.forget(lh);
        this.stats.hullsRetired++;
      }
    }
  }

  /** Placement (wreck fields 7, plan C5): push onto `out` the pieces of
   *  the hulls reaching into `box` that have no body now (not loaded), as
   *  a live piece's obstacle: centre, bounding radius, angle and convex
   *  parts. Hulls are found by home chunk (`hullsInChunk`) and seed
   *  footprint, the rocks' owning-chunk lookup (`fieldRocksInBox`). A hull
   *  with a lineage row gives its saved pieces at their saved poses (the
   *  restore resolver, `resolveLineageGeometry`); a consumed one nothing;
   *  else its seed pieces (`fieldHullPieces`). Nothing when wrecks are off.
   *  A discrete player action, never per tick; allocates. */
  dormantObstacles(box: ObstacleBox, out: GridObstacle[]): void {
    if (this.d.wrecks() === undefined || this.field.hulls.length === 0) return;
    const r = this.reach;
    const cx0 = Math.floor((box.x0 - r) / CHUNK_SIZE), cx1 = Math.floor((box.x1 + r) / CHUNK_SIZE);
    const cy0 = Math.floor((box.y0 - r) / CHUNK_SIZE), cy1 = Math.floor((box.y1 + r) / CHUNK_SIZE);
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > this.field.byChunk.size) {
      for (const h of this.field.hulls) this.dormantHull(h, box, out);
      return;
    }
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) for (const h of hullsInChunk(this.field, cx, cy)) this.dormantHull(h, box, out);
    }
  }

  private dormantHull(h: WreckFieldHull, box: ObstacleBox, out: GridObstacle[]): void {
    if (this.live.has(h.key) || !circleMeetsBox(h.x, h.y, h.footprint, box)) return;
    const row = this.rows.get(h.key);
    if (row?.consumed === true) return;
    if (row?.json != null && this.dormantRow(row.json, box, out)) return;
    for (const p of fieldHullPieces(h).pieces) pushPiece(out, box, p.x, p.y, p.radius, p.angle, p.parts);
  }

  /** A saved hull's pieces at their saved poses; false when the row does
   *  not resolve (the seed pieces stand in, as a reload would spawn them). */
  private dormantRow(json: string, box: ObstacleBox, out: GridObstacle[]): boolean {
    let raw: unknown;
    try { raw = JSON.parse(json); } catch { return false; }
    const rec = parseLineageRecord(raw);
    const g = rec === null ? null : resolveLineageGeometry(rec);
    if (rec === null || g === null) return false;
    for (const pc of rec.pieces) {
      const geom = g.geoms[pc.node]?.find((x) => x.index === pc.piece);
      if (geom !== undefined) pushPiece(out, box, pc.x, pc.y, geom.radius, pc.angle, geom.parts);
    }
    return true;
  }

  /** Forget chunk timing (room dispose: the pieces go with the world). */
  clear(): void {
    this.chunks.clear();
    this.waitUntil.clear();
    this.pending.clear();
    this.check.clear();
  }
}

/** Does the circle (x, y, r) reach into `box`? */
function circleMeetsBox(x: number, y: number, r: number, box: ObstacleBox): boolean {
  const dx = Math.max(box.x0 - x, 0, x - box.x1), dy = Math.max(box.y0 - y, 0, y - box.y1);
  return dx * dx + dy * dy < r * r;
}

/** A piece as a placement obstacle, when it reaches into `box`. */
function pushPiece(out: GridObstacle[], box: ObstacleBox, x: number, y: number, radius: number, angle: number, parts: GridObstacle['parts']): void {
  if (circleMeetsBox(x, y, radius, box)) out.push({ x, y, radius, angle, parts });
}
