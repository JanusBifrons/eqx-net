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
 * Retire (this slice's minimal rule): once a chunk has gone unneeded for the
 * linger, its UNTOUCHED hulls (no piece hit, split, gone, moved or on a
 * tractor) are removed through `dropPiece` and come back from the seed on
 * re-entry. A touched hull stays loaded: unloading it by where its pieces
 * are, and writing it to `terrain_records`, is slice 4. A hull key is live
 * at most once, so re-entry never double-spawns.
 *
 * #14: steady state (no chunk to load or retire) allocates nothing; a load
 * is generation-time work (the fracture allocates), bounded by the budget.
 */
import { chunkKeyX, chunkKeyY, type ChunkSource } from '../../core/terrain/chunkStreamer.js';
import { hullsInChunk, wreckFieldHullFracture, WRECK_FIELD, type WreckField, type WreckFieldHull, type WreckFieldOpts } from '../../core/terrain/wreckFieldLayout.js';
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
 *  its seed and the two sides that fought there (faction ids). */
export type WreckFieldRoomOpts = Pick<WreckFieldOpts, 'seed' | 'x' | 'y' | 'sides'>;

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
}

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
  /** Touched hulls a retire left loaded (slice 4 unloads them). */
  hullsKeptTouched: number;
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
  readonly stats: WreckFieldStats = { hullsLive: 0, hullsSpawned: 0, hullsRetired: 0, capRefusals: 0, hullsKeptTouched: 0, unitsThisStep: 0 };

  constructor(
    readonly field: WreckField,
    private readonly d: WreckFieldSourceDeps,
    private readonly lingerMs = 10_000,
  ) {}

  /** Lineage `root` changed (`CapitalWreckDeps.lineageTouched`): a spawn
   *  names its root; anything later (a hit, a split, a piece gone) marks
   *  the hull touched. No allocation. */
  touched(root: number): void {
    if (this.spawning !== null) { if (this.spawning.root === 0) this.spawning.root = root; return; }
    if (this.retiring) return;
    const h = this.byRoot.get(root);
    if (h !== undefined) h.touched = true;
  }

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
          if (this.live.has(h.key) || (this.waitUntil.get(h.key) ?? 0) > now) continue;
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
    this.stats.unitsThisStep = spent;
    this.stats.hullsLive = this.live.size;
    return Math.min(spent, budget);
  }

  /** Spawn hull `h` asleep, unless the field would pass its cap. */
  private load(wrecks: CapitalWreckSubsystem, h: WreckFieldHull, now: number): void {
    const { pieces, fracture } = fieldHullPieces(h);
    const host = wrecks.lineageState().host;
    if (wrecks.liveFieldCount() + pieces.length > host.cap(false, 'field')) {
      if (this.stats.capRefusals++ % CAP_WARN_EVERY === 0) {
        this.d.warn({ hullKey: h.key, kind: h.kindId, pieces: pieces.length, fieldLive: wrecks.liveFieldCount(), refusals: this.stats.capRefusals }, 'wreck field at its live cap: hull waits');
      }
      this.waitUntil.set(h.key, now + CAP_RETRY_MS);
      return;
    }
    this.waitUntil.delete(h.key);
    const lh: LiveHull = { hull: h, root: 0, ids: [], x: [], y: [], a: [], touched: false };
    this.spawning = lh;
    let n: number;
    try {
      n = wrecks.spawnWreck(h.kindId, `field:${h.key}`, pieces, fracture, getShipKind(h.kindId).maxHealth, h.angle,
        { held: false, origin: 'field', sleeping: true, cool: true, owner: h.owner });
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
   *  ones stay loaded (slice 4 unloads them by where their pieces are). */
  private retireUnneeded(needed: ReadonlySet<number>, now: number, wrecks: CapitalWreckSubsystem | undefined): void {
    for (const [key, ch] of this.chunks) {
      if (needed.has(key) || now - ch.lastNeededMs < this.lingerMs) continue;
      this.chunks.delete(key);
      this.freeChunks.push(ch);
      const hulls = hullsInChunk(this.field, chunkKeyX(key), chunkKeyY(key));
      for (let i = 0; i < hulls.length; i++) {
        const lh = this.live.get(hulls[i]!.key);
        if (lh === undefined || wrecks === undefined) continue;
        if (this.isTouched(lh)) { lh.touched = true; this.stats.hullsKeptTouched++; continue; }
        this.retiring = true;
        try { for (let j = 0; j < lh.ids.length; j++) wrecks.retireFieldPiece(lh.ids[j]!); } finally { this.retiring = false; }
        this.live.delete(lh.hull.key);
        this.byRoot.delete(lh.root);
        this.stats.hullsRetired++;
      }
    }
  }

  /** Forget chunk timing (room dispose: the pieces go with the world). */
  clear(): void {
    this.chunks.clear();
    this.waitUntil.clear();
  }
}
