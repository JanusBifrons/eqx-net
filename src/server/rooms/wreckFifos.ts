/**
 * The wreck FIFO host (wreck fields plan, review 3 "Origin-aware FIFO host";
 * docs/architecture/capital-destruction.md "Origins and live caps"): the
 * lists of live wreck piece ids `CapitalWreckSubsystem` keeps, one per
 * origin and class.
 *
 *  - BATTLE pieces (ship deaths, rock cuts, restored battles) live in two
 *    evicting FIFOs, capital and sub-cap, oldest first. Eviction and the
 *    battle re-split gate read these lists only, so a battle never evicts a
 *    field piece and field pieces never take a battle slot.
 *  - FIELD pieces (old battlefields streamed in by chunk) live in one list
 *    that never evicts: distance bounds them (the streamer unloads a hull
 *    whose pieces are all far from ships). Its cap only gates re-splits:
 *    `fieldLive - 1 + maxPieces <= FIELD_LIVE_CAP`.
 *
 * Every removal goes through the subsystem's `dropPiece` (or the battle
 * eviction); a field piece that leaves by any other path is taken out of its
 * list in `pieceGone` (`forgetField`), so the non-evicting list never holds
 * a stale id. No per-tick work here: lists change on spawn and removal only.
 */
import { MAX_LIVE_SUBCAP_WRECK_PIECES, MAX_LIVE_WRECK_PIECES } from '../../core/destruction/wreckPieces.js';
import type { WreckOrigin } from './capitalWreckTypes.js';

/** Worst live field pieces in ONE ship's 5 x 5 chunk ring, measured by
 *  `wreckFieldLayout.test.ts` (slice 1, seed `a`: 56; `thornfield` 37, `b`
 *  21). The streamer keeps that ring loaded around each ship
 *  (macro-terrain.md "One streamer, several sources"). */
export const FIELD_RING_WORST_PIECES = 56;
/** Ships the cap allows to sit in separate parts of the field at once: a
 *  sector room's `maxClients` (16, `GalaxyRegistry` / `index.ts`). */
export const FIELD_CAP_SHIPS = 16;
/** Live field pieces the re-split gate allows: every one of
 *  `FIELD_CAP_SHIPS` rings at the measured worst, plus one more ring of
 *  headroom for re-split children and a fast ship's lingering chunks.
 *  56 x (16 + 1) = 952. With the battle caps (768 + 2000) that is 3,720 of
 *  the 5,120 physics slots (`MAX_ENTITIES`). */
export const FIELD_LIVE_CAP = FIELD_RING_WORST_PIECES * (FIELD_CAP_SHIPS + 1);

export class WreckFifos {
  /** Live battle capital pieces, oldest first (evicting FIFO). */
  readonly capital: string[] = [];
  /** Live battle sub-capital pieces, oldest first: a separate FIFO, so
   *  sub-cap debris never evicts a capital piece. */
  readonly subcap: string[] = [];
  /** Live field pieces (never evicted). */
  readonly field: string[] = [];
  /** Test seams: smaller caps (null: the constants). */
  subcapCapOverride: number | null = null;
  fieldCapOverride: number | null = null;

  /** The list a piece of this class and origin lives in. */
  list(capital: boolean, origin: WreckOrigin): string[] {
    if (origin === 'field') return this.field;
    return capital ? this.capital : this.subcap;
  }

  /** That list's cap (battle: its eviction cap; field: the re-split gate). */
  cap(capital: boolean, origin: WreckOrigin): number {
    if (origin === 'field') return this.fieldCapOverride ?? FIELD_LIVE_CAP;
    return capital ? MAX_LIVE_WRECK_PIECES : (this.subcapCapOverride ?? MAX_LIVE_SUBCAP_WRECK_PIECES);
  }

  /** The list holding piece `id` (a store: once per stored piece). */
  holding(id: string): string[] | null {
    if (this.capital.includes(id)) return this.capital;
    if (this.subcap.includes(id)) return this.subcap;
    if (this.field.includes(id)) return this.field;
    return null;
  }

  /** Take a field piece that left by another path out of the field list. */
  forgetField(id: string): void {
    const i = this.field.indexOf(id);
    if (i >= 0) this.field.splice(i, 1);
  }

  /** Evict the oldest BATTLE pieces of one class down to its cap, each
   *  through `evict`. Field pieces are never evicted. */
  enforce(capital: boolean, evict: (id: string) => void): void {
    const fifo = capital ? this.capital : this.subcap;
    const max = this.cap(capital, 'battle');
    while (fifo.length > max) evict(fifo.shift()!);
  }

  /** Live battle pieces (both classes). */
  battleCount(): number { return this.capital.length + this.subcap.length; }
  /** Live field pieces. */
  fieldCount(): number { return this.field.length; }
  /** Every live piece, all origins. */
  count(): number { return this.capital.length + this.subcap.length + this.field.length; }
}
