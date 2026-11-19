/**
 * What both streamed wreck sources share (wreck fields plan slices 4 and 0b;
 * docs/architecture/macro-terrain.md "F3"): a wreck-field hull
 * (`WreckFieldSource`) and a battle lineage (`BattleWreckSaves`) unload and
 * come back the same way, so the pieces of that way live here once.
 *
 *  - WHERE: a lineage is where its pieces are. `LineageUnloader.near` says
 *    whether any live piece of a lineage lies in a chunk the streamer needs,
 *    or is on a tractor (made-once visitor: no allocation, #14).
 *  - UNLOAD: `LineageUnloader.retire` takes every live piece of a lineage
 *    out through the wreck system's `dropPiece` (each from its own list, by
 *    class and origin); its ancestors retire with their last piece.
 *  - ROWS: `parseLineageJson` reads a saved row (#3: parsed, never trusted).
 *  - BUDGET: a hull's fracture + spawn costs `FIELD_HULL_UNITS` of the
 *    streamer's shared budget by size class (measured); a restored battle
 *    lineage costs the same by its root's class (`lineageUnits`).
 */
import { chunkKey } from '../../core/terrain/chunkStreamer.js';
import { CHUNK_SIZE } from '../../core/terrain/fieldLayout.js';
import { WRECK_FIELD } from '../../core/terrain/wreckFieldLayout.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import { parseLineageRecord, type WreckLineageRecord } from './wreckLineageRecord.js';
import { forEachLineagePiece } from './wreckLineage.js';
import type { WreckLineageState } from './wreckLineageSaves.js';
import type { LiveWreck } from './capitalWreckTypes.js';
import type { WreckPiecePose } from './wreckResplit.js';

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

/** A saved lineage's restore cost: its root hull's (`fieldHullUnits`, the
 *  same resolve + spawn work); a rock-cut lineage's pieces ride the sub-cap
 *  FIFO, so it costs a sub-cap hull's. */
export function lineageUnits(rec: WreckLineageRecord): number {
  const d = rec.nodes[0]?.desc;
  if (d === undefined || d.rock !== undefined) return FIELD_HULL_UNITS.subcap;
  return fieldHullUnits(d.parentKind as ShipKindId);
}

/** A saved lineage row's JSON as a record (null: unreadable or another
 *  fracture version; `algo` is the version it named, for the warning). */
export function parseLineageJson(json: string): { rec: WreckLineageRecord | null; algo: unknown } {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { raw = undefined; }
  return { rec: raw === undefined ? null : parseLineageRecord(raw), algo: (raw as { fractureAlgo?: unknown } | undefined)?.fractureAlgo };
}

/** The chunk keys (`chunkKey`) a saved lineage's pieces lie in, unique. */
export function lineageChunks(rec: WreckLineageRecord): number[] {
  const out: number[] = [];
  for (const p of rec.pieces) {
    const k = chunkKey(Math.floor(p.x / CHUNK_SIZE), Math.floor(p.y / CHUNK_SIZE));
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

export interface LineageUnloaderDeps {
  /** A live piece's pose into `out`; false when it is gone. */
  piecePoseInto(id: string, out: WreckPiecePose): boolean;
  /** Is a piece on a tractor lease? Absent ⇒ never. */
  tractored?(id: string): boolean;
}

/** Where a lineage is, and taking it out: one per streamed source. */
export class LineageUnloader {
  private needed: ReadonlySet<number> = new Set<number>();
  private hit = false;
  private readonly pose: WreckPiecePose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  private readonly ids: string[] = [];
  /** Made once (#14). */
  private readonly visitNear = (id: string): void => {
    if (this.hit) return;
    if (this.d.tractored?.(id) === true) { this.hit = true; return; }
    if (this.d.piecePoseInto(id, this.pose)
      && this.needed.has(chunkKey(Math.floor(this.pose.x / CHUNK_SIZE), Math.floor(this.pose.y / CHUNK_SIZE)))) this.hit = true;
  };
  private readonly collect = (id: string): void => { this.ids.push(id); };

  constructor(private readonly d: LineageUnloaderDeps) {}

  /** Is any live piece of lineage `root` in a chunk of `needed`, or on a
   *  tractor? No allocation. */
  near(s: WreckLineageState, root: number, needed: ReadonlySet<number>): boolean {
    this.needed = needed;
    this.hit = false;
    forEachLineagePiece(s.wrecks, s.pieceWreck, root, this.visitNear);
    return this.hit;
  }

  /** Is any live piece of the one wreck `w` near (as `near`)? A sweep over
   *  every wreck marks whole lineages in one pass. No allocation. */
  wreckNear(s: WreckLineageState, w: LiveWreck, needed: ReadonlySet<number>): boolean {
    this.needed = needed;
    this.hit = false;
    const wreckId = w.desc.wreckId;
    for (let i = 0; i < w.ids.length && !this.hit; i++) {
      const id = w.ids[i]!;
      if (s.pieceWreck.get(id) === wreckId) this.visitNear(id);
    }
    return this.hit;
  }

  /** Every live piece of lineage `root` out through `dropPiece`, each from
   *  its own list (class and origin); its wrecks retire with their last
   *  piece. A chunk event. */
  retire(s: WreckLineageState, root: number): void {
    const ids = this.ids;
    ids.length = 0;
    forEachLineagePiece(s.wrecks, s.pieceWreck, root, this.collect);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const w = s.wrecks.get(s.pieceWreck.get(id) ?? -1);
      if (w !== undefined) s.host.dropPiece(id, s.host.fifo(w.src.profile.id === 'capital', w.origin));
    }
    ids.length = 0;
  }
}
