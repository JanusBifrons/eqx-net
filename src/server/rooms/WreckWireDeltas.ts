/**
 * Sub-capital break-up slice 3 — wreck descriptors on the wire as DELTAS.
 *
 * Before, every snapshot for a few broadcasts after ANY change (and at 2 Hz
 * otherwise) carried the whole live `wrecks[]` list. At ~200 sub-capital
 * deaths a minute, with permanent wrecks, that list rides almost every
 * snapshot and grows with every wreck. Now:
 *   - the FULL set rides the welcome (`SectorRoom.wreckWelcomeFields`);
 *   - each snapshot carries the ADDS and REMOVES of the last
 *     `WRECK_DELTA_WINDOW` broadcast counters (6 snapshots per recipient,
 *     so one dropped snapshot never loses one);
 *   - one snapshot in `WRECK_RESYNC_EVERY` (2 Hz per recipient) carries a
 *     resync chunk of `WRECK_RESYNC_CHUNK` descriptors: "the live wrecks with
 *     lo <= id < hi are exactly these". The chunks walk the u16 id space, so
 *     a client that missed an add OR a remove converges (#16).
 *
 * The broadcaster calls `step` once per non-idle `broadcast()`; it diffs the
 * subsystem's live list against what it last saw only when the subsystem's
 * version moved, so no change to `CapitalWreckSubsystem` is needed. The three
 * wire values (`adds`, `removes`, `sync`) are shared by every recipient and
 * reused (#14); a pending add or remove is one slot in parallel arrays.
 */
import type { WreckDescriptor, WreckSync } from '../../shared-types/messages.js';
import { WRECK_ID_END } from '../../shared-types/messages/snapshotMessages.js';

export { WRECK_ID_END };

/** Broadcast counters an add or remove keeps riding: each recipient gets one
 *  snapshot per 3 counters, so 18 = six snapshots (~300 ms at 20 Hz). */
export const WRECK_DELTA_WINDOW = 18;
/** Counters between resync chunks: one snapshot per recipient each (2 Hz). */
export const WRECK_RESYNC_EVERY = 30;
/** Descriptors per resync chunk (~12 a second per recipient). */
export const WRECK_RESYNC_CHUNK = 6;

interface Known {
  desc: WreckDescriptor;
  gen: number;
}

function byNumber(a: number, b: number): number {
  return a - b;
}

export class WreckWireDeltas {
  /** Descriptors added within the window (one per id). */
  readonly adds: WreckDescriptor[] = [];
  private readonly addAt: number[] = [];
  /** Wreck ids removed within the window (never also in `adds`). */
  readonly removes: number[] = [];
  private readonly removeAt: number[] = [];
  /** The current resync chunk. */
  readonly sync: WreckSync = { lo: 1, hi: WRECK_ID_END, d: [] };

  private readonly known = new Map<number, Known>();
  private readonly pool: Known[] = [];
  private gen = 0;
  private versionSeen = -1;
  private syncWindow = -1;
  private syncLo = 1;
  private readonly ids: number[] = [];
  private readonly pushId = (_v: Known, id: number): void => { this.ids.push(id); };
  private readonly sweep = (k: Known, id: number): void => {
    if (k.gen === this.gen) return;
    this.known.delete(id);
    this.pool.push(k);
    this.noteRemove(id);
  };
  private counter = 0;

  /** Advance to broadcast `counter` with the subsystem's live `list`. */
  step(counter: number, list: readonly WreckDescriptor[], version: number): void {
    this.counter = counter;
    if (version !== this.versionSeen) {
      this.versionSeen = version;
      this.diff(list);
    }
    this.expire(counter);
    const window = Math.floor(counter / WRECK_RESYNC_EVERY);
    if (window !== this.syncWindow) {
      this.syncWindow = window;
      this.buildSync();
    }
  }

  /** Does a recipient's snapshot at this counter carry the resync chunk?
   *  Each recipient gets exactly one snapshot in any 3 consecutive counters. */
  syncDue(counter: number): boolean {
    return counter % WRECK_RESYNC_EVERY < 3;
  }

  /** Live wrecks this side has seen (tests). */
  liveCount(): number {
    return this.known.size;
  }

  private diff(list: readonly WreckDescriptor[]): void {
    const gen = ++this.gen;
    for (let i = 0; i < list.length; i++) {
      const d = list[i]!;
      let k = this.known.get(d.wreckId);
      if (k === undefined) {
        k = this.pool.pop() ?? { desc: d, gen }; // TODO: alloc-debt — once per wreck ever alive at once (a death event), pooled after
        k.desc = d;
        this.known.set(d.wreckId, k);
        this.noteAdd(d);
      } else if (k.desc !== d) {
        // A recycled id: a new wreck under an old id.
        k.desc = d;
        this.noteAdd(d);
      }
      k.gen = gen;
    }
    if (this.known.size > list.length) this.known.forEach(this.sweep);
  }

  private noteAdd(d: WreckDescriptor): void {
    const id = d.wreckId;
    for (let i = 0; i < this.removes.length; i++) {
      if (this.removes[i] === id) { this.dropRemove(i); break; }
    }
    for (let i = 0; i < this.adds.length; i++) {
      if (this.adds[i]!.wreckId === id) {
        this.adds[i] = d;
        this.addAt[i] = this.counter;
        return;
      }
    }
    this.adds.push(d);
    this.addAt.push(this.counter);
  }

  private noteRemove(id: number): void {
    for (let i = 0; i < this.adds.length; i++) {
      if (this.adds[i]!.wreckId === id) { this.dropAdd(i); break; }
    }
    for (let i = 0; i < this.removes.length; i++) {
      if (this.removes[i] === id) { this.removeAt[i] = this.counter; return; }
    }
    this.removes.push(id);
    this.removeAt.push(this.counter);
  }

  private dropAdd(i: number): void {
    const last = this.adds.length - 1;
    this.adds[i] = this.adds[last]!;
    this.addAt[i] = this.addAt[last]!;
    this.adds.length = last;
    this.addAt.length = last;
  }

  private dropRemove(i: number): void {
    const last = this.removes.length - 1;
    this.removes[i] = this.removes[last]!;
    this.removeAt[i] = this.removeAt[last]!;
    this.removes.length = last;
    this.removeAt.length = last;
  }

  private expire(counter: number): void {
    for (let i = this.adds.length - 1; i >= 0; i--) {
      if (counter - this.addAt[i]! >= WRECK_DELTA_WINDOW) this.dropAdd(i);
    }
    for (let i = this.removes.length - 1; i >= 0; i--) {
      if (counter - this.removeAt[i]! >= WRECK_DELTA_WINDOW) this.dropRemove(i);
    }
  }

  /** The next chunk: up to `WRECK_RESYNC_CHUNK` live wrecks from `syncLo` up,
   *  in id order. It covers `[syncLo, last + 1)`, or to the end of the id
   *  space when it reached the last live id (then the walk wraps). */
  private buildSync(): void {
    const ids = this.ids;
    ids.length = 0;
    this.known.forEach(this.pushId);
    ids.sort(byNumber);
    let i = 0;
    while (i < ids.length && ids[i]! < this.syncLo) i++;
    const d = this.sync.d;
    d.length = 0;
    const end = Math.min(ids.length, i + WRECK_RESYNC_CHUNK);
    for (let j = i; j < end; j++) d.push(this.known.get(ids[j]!)!.desc);
    this.sync.lo = this.syncLo;
    if (end >= ids.length) {
      this.sync.hi = WRECK_ID_END;
      this.syncLo = 1;
    } else {
      this.sync.hi = ids[end - 1]! + 1;
      this.syncLo = this.sync.hi;
    }
  }
}
