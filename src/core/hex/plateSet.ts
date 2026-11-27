/**
 * Base platforms slice 5 — the DERIVED plate set (plan
 * `.resume/base-platforms-plan.md`). A plate is not an entity and rides no
 * wire field: owner O has plate (i, j) while O owns a connector-kind
 * structure ({@link isConnectorKind}), built OR blueprint, sitting on the
 * world centre of that plate's middle hex (within {@link PLATE_CENTRE_TOLERANCE}).
 *
 * One class, both sides (invariant 15): the server's `StructureRegistry`
 * feeds it on add / remove / owner change, the client's `StructureRowSync`
 * feeds it as room-state rows decode and leave. Updated incrementally per
 * structure, never rebuilt per query; queries allocate nothing (invariant 14).
 * `K` is the structure key (server string id, client entityId).
 */
import { isConnectorKind } from '../../shared-types/structureKinds.js';
import { pixelToAxialInto, type AxialHex, type HexPoint } from './hex.js';
import { DECK_HEX_SIZE, deckHexCentreInto, plateOfHexInto, type PlateIndex } from './plates.js';

/** How far (world units) a connector may sit from a plate centre and still anchor it. */
export const PLATE_CENTRE_TOLERANCE = 1;

/** Receives each plate in {@link PlateSet.forEachPlate}. */
export type PlateVisitor = (i: number, j: number) => void;

/** Plate lattice indices packed into one number (no string keys, no alloc). */
const PACK_OFFSET = 1 << 20;
const PACK_SPAN = 1 << 21;
function packPlate(i: number, j: number): number {
  return (i + PACK_OFFSET) * PACK_SPAN + (j + PACK_OFFSET);
}
function unpackI(k: number): number {
  return Math.floor(k / PACK_SPAN) - PACK_OFFSET;
}
function unpackJ(k: number): number {
  return (k % PACK_SPAN) - PACK_OFFSET;
}

/** One owner's plates: anchor counts per plate + a dense list for iteration. */
interface OwnerPlates {
  /** packed plate → number of connectors anchoring it (≥ 1). */
  count: Map<number, number>;
  /** packed plate → its index in `list`. */
  at: Map<number, number>;
  list: number[];
}

/** What a tracked structure contributes. */
interface Anchor {
  owner: string;
  key: number;
}

const HEX: AxialHex = { q: 0, r: 0 };
const CENTRE: AxialHex = { q: 0, r: 0 };
const PLATE: PlateIndex = { i: 0, j: 0 };
const PT: HexPoint = { x: 0, y: 0 };

/**
 * Allocation-free: if (x, y) is (within {@link PLATE_CENTRE_TOLERANCE}) the
 * world centre of a plate's middle hex, writes that plate into `out` and
 * returns true.
 */
export function plateCentreAtWorldInto(x: number, y: number, out: PlateIndex): boolean {
  pixelToAxialInto(x, y, DECK_HEX_SIZE, HEX);
  plateOfHexInto(HEX.q, HEX.r, out, CENTRE);
  if (CENTRE.q !== HEX.q || CENTRE.r !== HEX.r) return false;
  deckHexCentreInto(HEX.q, HEX.r, PT);
  const dx = x - PT.x;
  const dy = y - PT.y;
  return dx * dx + dy * dy <= PLATE_CENTRE_TOLERANCE * PLATE_CENTRE_TOLERANCE;
}

export class PlateSet<K = string> {
  /** Bumped whenever any owner gains or loses a plate (not on a second
   *  anchor of a plate already held): readers cache against it. Read it;
   *  never write it. */
  version = 0;
  private readonly anchors = new Map<K, Anchor>();
  private readonly owners = new Map<string, OwnerPlates>();

  /**
   * (Re)state structure `id`: its owner, kind and world centre. Adds, moves
   * or drops its plate anchor as needed. Call on add, on any change of owner
   * or kind, and on a re-decode; idempotent.
   */
  upsert(id: K, owner: string, kind: string | null | undefined, x: number, y: number): void {
    const key = isConnectorKind(kind) && plateCentreAtWorldInto(x, y, PLATE) ? packPlate(PLATE.i, PLATE.j) : -1;
    const prev = this.anchors.get(id);
    if (prev && prev.owner === owner && prev.key === key) return;
    if (prev) {
      this.release(prev.owner, prev.key);
      if (key < 0) { this.anchors.delete(id); return; }
      prev.owner = owner;
      prev.key = key;
    } else {
      if (key < 0) return;
      this.anchors.set(id, { owner, key });
    }
    this.retain(owner, key);
  }

  /** Structure `id` left the world. */
  remove(id: K): void {
    const prev = this.anchors.get(id);
    if (!prev) return;
    this.anchors.delete(id);
    this.release(prev.owner, prev.key);
  }

  /** Forget everything (a room-state reset). */
  clear(): void {
    if (this.owners.size > 0) this.version++;
    this.anchors.clear();
    this.owners.clear();
  }

  /** The owner structure `id` anchors a plate for, or undefined if it anchors none. */
  anchorOwner(id: K): string | undefined {
    return this.anchors.get(id)?.owner;
  }

  /** The structures currently anchoring a plate (for an owner re-check). */
  anchorIds(): IterableIterator<K> {
    return this.anchors.keys();
  }

  hasPlate(owner: string, i: number, j: number): boolean {
    return this.owners.get(owner)?.count.has(packPlate(i, j)) === true;
  }

  /** Is world point (x, y) on one of `owner`'s plates (its hex is in one)? */
  plateAtWorld(owner: string, x: number, y: number): boolean {
    const op = this.owners.get(owner);
    if (!op) return false;
    pixelToAxialInto(x, y, DECK_HEX_SIZE, HEX);
    plateOfHexInto(HEX.q, HEX.r, PLATE);
    return op.count.has(packPlate(PLATE.i, PLATE.j));
  }

  /** How many plates `owner` has. */
  plateCount(owner: string): number {
    return this.owners.get(owner)?.list.length ?? 0;
  }

  /** Visit each of `owner`'s plates (order unspecified). Allocation-free. */
  forEachPlate(owner: string, visit: PlateVisitor): void {
    const op = this.owners.get(owner);
    if (!op) return;
    const list = op.list;
    for (let n = 0; n < list.length; n++) visit(unpackI(list[n]!), unpackJ(list[n]!));
  }

  /** Visit every owner's plates (order unspecified). Read on a {@link version} change, not per frame. */
  forEachOwnerPlate(visit: (owner: string, i: number, j: number) => void): void {
    for (const [owner, op] of this.owners) {
      const list = op.list;
      for (let n = 0; n < list.length; n++) visit(owner, unpackI(list[n]!), unpackJ(list[n]!));
    }
  }

  /**
   * Write `owner`'s plates into `out` as flat (i, j) pairs (cleared first);
   * the wire copy the worker renderer's {@link OwnerPlateList} reads.
   * Allocation-free once `out` has grown.
   */
  platesInto(owner: string, out: number[]): number[] {
    out.length = 0;
    const list = this.owners.get(owner)?.list;
    if (!list) return out;
    for (let n = 0; n < list.length; n++) out.push(unpackI(list[n]!), unpackJ(list[n]!));
    return out;
  }

  private retain(owner: string, key: number): void {
    let op = this.owners.get(owner);
    if (!op) {
      op = { count: new Map(), at: new Map(), list: [] };
      this.owners.set(owner, op);
    }
    const c = op.count.get(key);
    if (c !== undefined) { op.count.set(key, c + 1); return; }
    op.count.set(key, 1);
    this.version++;
    op.at.set(key, op.list.length);
    op.list.push(key);
  }

  private release(owner: string, key: number): void {
    const op = this.owners.get(owner);
    const c = op?.count.get(key);
    if (!op || c === undefined) return;
    if (c > 1) { op.count.set(key, c - 1); return; }
    op.count.delete(key);
    this.version++;
    const idx = op.at.get(key)!;
    const last = op.list.pop()!;
    op.at.delete(key);
    if (last !== key) {
      op.list[idx] = last;
      op.at.set(last, idx);
    }
    if (op.list.length === 0) this.owners.delete(owner);
  }
}

/** Plate scratch for {@link isPlateAnchor} (invariant 14). */
const ANCHOR_PLATE: PlateIndex = { i: 0, j: 0 };

/**
 * Does a structure of `kind` at world (x, y) anchor a plate (a connector-kind
 * on a plate centre; slice 9)? The same rule {@link PlateSet.upsert} keys on.
 * Allocation-free.
 */
export function isPlateAnchor(kind: string | null | undefined, x: number, y: number): boolean {
  return isConnectorKind(kind) && plateCentreAtWorldInto(x, y, ANCHOR_PLATE);
}

/**
 * Slice 9 restore order: the rows that anchor a plate ({@link isPlateAnchor})
 * first, then the rest, each group in its original order (stable). Not a hot
 * path (hydrate only), so it returns a new array.
 */
export function plateAnchorsFirst<T extends { kind: string; x: number; y: number }>(rows: readonly T[]): T[] {
  const anchors: T[] = [];
  const rest: T[] = [];
  for (const r of rows) (isPlateAnchor(r.kind, r.x, r.y) ? anchors : rest).push(r);
  return anchors.concat(rest);
}

/**
 * One owner's plates as a flat (i, j) pair list ({@link PlateSet.platesInto}):
 * the renderer (possibly in a worker, with no `PlateSet`) answers the same
 * {@link PlateSet.plateAtWorld} query from the copy the placement preview
 * carries. A view of the set, not a second one: few plates, linear scan,
 * allocation-free.
 */
export class OwnerPlateList {
  owner = '';
  pairs: readonly number[] = [];

  set(owner: string, pairs: readonly number[]): this {
    this.owner = owner;
    this.pairs = pairs;
    return this;
  }

  plateAtWorld(owner: string, x: number, y: number): boolean {
    if (owner !== this.owner) return false;
    pixelToAxialInto(x, y, DECK_HEX_SIZE, HEX);
    plateOfHexInto(HEX.q, HEX.r, PLATE);
    const p = this.pairs;
    for (let n = 0; n + 1 < p.length; n += 2) if (p[n] === PLATE.i && p[n + 1] === PLATE.j) return true;
    return false;
  }
}
