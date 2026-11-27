/**
 * Plan then Build: a batch of planned buildings checked against ITSELF, as
 * if the earlier items of the batch were already placed. The server runs it
 * on `place_structures` (all or nothing); the client runs the same check on
 * its planned list to paint clashing ghosts red (invariant 15).
 *
 * On top of {@link placementRejection} against the world:
 *   - each item may not overlap an EARLIER item of the batch (footprint and
 *     landing pad, the same rule as against a placed structure);
 *   - on a deck room, a plate the batch lays (a connector on a plate centre)
 *     counts as the owner's deck for every OTHER item, whatever the order:
 *     the batch is all or nothing, so if the plate is refused nothing lands;
 *   - batch items never block the plate a batch connector lays (they are the
 *     planned contents of that plate);
 *   - {@link BatchPlacementChecker.countOf} gives how many items of a kind came
 *     earlier, so a stock (packed crates) is summed across the batch.
 *
 * Allocation-free after warm-up (the footprint pool grows to the largest
 * batch once): it runs from `onMessage` (invariant 14).
 */
import { getStructureKind, structureHalfExtentsInto } from '../../shared-types/structureKinds.js';
import { pixelToAxialInto, type AxialHex } from '../hex/hex.js';
import { DECK_HEX_SIZE, plateOfHexInto, type PlateIndex } from '../hex/plates.js';
import { isPlateAnchor, plateCentreAtWorldInto } from '../hex/plateSet.js';
import type { GridObstacle } from './Grid.js';
import {
  placementRejection,
  type DeckPlateQuery,
  type PlacementDeck,
  type PlacementFootprint,
  type PlacementRejection,
} from './placementRules.js';

/** One planned building (pose already snapped and normalised). */
export interface BatchPlacementItem {
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  /** Degrees. */
  readonly rot: number;
  readonly mirror?: boolean;
}

/** An earlier batch item as a kind rule sees it (`earlierItems`). */
export interface BatchEarlierItem {
  readonly kind: string;
  readonly owner: string;
}

interface BatchSlot extends PlacementFootprint {
  kind: string;
  owner: string;
  rot: number;
  /** Lays a plate (`isPlateAnchor`); its plate in `pi`/`pj`. */
  anchor: boolean;
  pi: number;
  pj: number;
}

const HEX: AxialHex = { q: 0, r: 0 };
const PLATE: PlateIndex = { i: 0, j: 0 };
const EXT = { hw: 0, hh: 0 };

/**
 * Checks a batch item by item. Use: `begin(items, deck)`, then for each index
 * `rejection(i, structures, obstacles)` in order (each sees the items before
 * it). Reuse one instance (scratch lives on it).
 */
export class BatchPlacementChecker {
  private readonly slots: BatchSlot[] = [];
  private n = 0;
  /** Items before the one being checked (`rejection`'s second pass). */
  private upTo = 0;
  /** The item being checked: excluded from the batch's own plates. */
  private self = -1;
  private base: PlacementDeck | null = null;
  private readonly deck: PlacementDeck;
  private readonly earlier: Iterable<BatchSlot>;

  constructor() {
    const plates: DeckPlateQuery = {
      plateAtWorld: (owner, x, y) => (this.base !== null && this.base.plates.plateAtWorld(owner, x, y)) || this.onBatchPlate(x, y),
    };
    this.deck = { plates, owner: '' };
    // One reusable iterator over slots[0..upTo) (no per-call allocation).
    let k = 0;
    const res = { value: undefined as unknown as BatchSlot, done: false };
    const it: Iterator<BatchSlot> = {
      next: () => {
        if (k < this.upTo) { res.value = this.slots[k++]!; res.done = false; } else { res.done = true; }
        return res;
      },
    };
    this.earlier = { [Symbol.iterator]: () => { k = 0; return it; } };
  }

  /** Start a batch placed by `owner`. `deck`: the room's deck rule (null = none). */
  begin(items: readonly BatchPlacementItem[], deck: PlacementDeck | null, owner = ''): void {
    this.base = deck;
    if (deck !== null) this.deck.owner = deck.owner;
    this.n = items.length;
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      let s = this.slots[i];
      if (s === undefined) {
        s = { x: 0, y: 0, radius: 0, halfW: 0, halfH: 0, kind: '', owner: '', rot: 0, mirror: false, anchor: false, pi: 0, pj: 0 };
        this.slots.push(s);
      }
      structureHalfExtentsInto(it.kind, it.rot, EXT);
      s.x = it.x; s.y = it.y; s.kind = it.kind; s.owner = owner; s.rot = it.rot; s.mirror = it.mirror === true;
      s.radius = getStructureKind(it.kind).radius;
      s.halfW = EXT.hw; s.halfH = EXT.hh;
      s.anchor = isPlateAnchor(it.kind, it.x, it.y) && plateCentreAtWorldInto(it.x, it.y, PLATE);
      s.pi = PLATE.i; s.pj = PLATE.j;
    }
  }

  /**
   * Why item `index` cannot be placed: against the world (`structures`,
   * `obstacles`, the deck plus the batch's other plates), then against the
   * batch items before it. Null = legal.
   */
  rejection(index: number, structures: Iterable<PlacementFootprint>, obstacles?: readonly GridObstacle[] | null): PlacementRejection | null {
    const s = this.slots[index]!;
    this.self = index;
    const world = placementRejection(s.kind, s.x, s.y, structures, obstacles, s.rot, s.mirror, this.base === null ? null : this.deck);
    this.self = -1;
    if (world !== null) return world;
    this.upTo = index;
    return placementRejection(s.kind, s.x, s.y, this.earlier, null, s.rot, s.mirror, null);
  }

  /** The batch items before `index`, for a kind's own rule (one Territory
   *  Lock per sector) to count as placed. A reusable view: read it before the
   *  next `rejection` / `earlierItems` call. */
  earlierItems(index: number): Iterable<BatchEarlierItem> {
    this.upTo = index;
    return this.earlier;
  }

  /** How many items of `kind` come before `index` in the batch. */
  countOf(kind: string, index: number): number {
    let c = 0;
    for (let i = 0; i < index && i < this.n; i++) if (this.slots[i]!.kind === kind) c++;
    return c;
  }

  /** Does item `index` lay a plate (commit it before the rest)? */
  isAnchor(index: number): boolean {
    return this.slots[index]!.anchor;
  }

  /** The deck as the batch sees it: the room's deck (`begin`'s) plus every
   *  plate the batch lays, so a building judged against the batch from outside
   *  it (the client's live ghost over its planned list) may stand on a planned
   *  plate. Null when `begin` had no deck. Valid until the next `begin`. */
  deckWithBatch(): PlacementDeck | null {
    this.self = -1;
    return this.base === null ? null : this.deck;
  }

  /** Is (x, y) on a plate another item of the batch lays? */
  private onBatchPlate(x: number, y: number): boolean {
    let found = false;
    for (let i = 0; i < this.n; i++) {
      const s = this.slots[i]!;
      if (!s.anchor || i === this.self) continue;
      if (!found) {
        pixelToAxialInto(x, y, DECK_HEX_SIZE, HEX);
        plateOfHexInto(HEX.q, HEX.r, PLATE);
        found = true;
      }
      if (PLATE.i === s.pi && PLATE.j === s.pj) return true;
    }
    return false;
  }
}

/**
 * Every refused item of a batch, for the client's planned list: writes the
 * refused indices into `outIndex` and their reasons into `outCode` (same
 * length; both cleared first). `obstaclesFor(i)` gives the obstacles near
 * item i (omit for structures only). Crate stock is the server's
 * (`countOf`), not checked here.
 */
export function batchPlacementRejections(
  checker: BatchPlacementChecker,
  items: readonly BatchPlacementItem[],
  structures: Iterable<PlacementFootprint>,
  deck: PlacementDeck | null,
  outIndex: number[],
  outCode: PlacementRejection[],
  obstaclesFor?: (index: number) => readonly GridObstacle[] | null,
): number {
  outIndex.length = 0;
  outCode.length = 0;
  checker.begin(items, deck);
  for (let i = 0; i < items.length; i++) {
    const r = checker.rejection(i, structures, obstaclesFor?.(i));
    if (r !== null) { outIndex.push(i); outCode.push(r); }
  }
  return outIndex.length;
}
