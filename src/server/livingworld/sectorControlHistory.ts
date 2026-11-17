/**
 * Galaxy feed — an hour of each sector's control, one sample a minute
 * (holder + holder share), served at `GET /galaxy/sector/:key/history`.
 *
 * Owned by `RobotTerritory` (the control meter) and sampled from its control
 * tick, so storage is preallocated per sector at construction: a ring of
 * HISTORY_SAMPLES slots in typed arrays plus a holder-id slot array. Sampling
 * writes into the ring and allocates nothing; only `samples()` (the HTTP read)
 * builds an array.
 */
import type { SectorHistorySample } from '../../shared-types/galaxySnapshot.js';

/** Samples kept per sector (an hour at one a minute). */
export const HISTORY_SAMPLES = 60;
/** One sample per this much game time. */
export const HISTORY_SAMPLE_MS = 60_000;

interface Ring {
  atMs: Float64Array;
  share: Float32Array;
  holder: (string | null)[];
  /** Next slot to write. */
  head: number;
  /** Filled slots (≤ HISTORY_SAMPLES). */
  count: number;
}

export class SectorControlHistory {
  private readonly rings = new Map<string, Ring>();
  private nextSampleAtMs = -Infinity;

  constructor(sectorKeys: Iterable<string>) {
    for (const key of sectorKeys) {
      this.rings.set(key, {
        atMs: new Float64Array(HISTORY_SAMPLES),
        share: new Float32Array(HISTORY_SAMPLES),
        holder: new Array<string | null>(HISTORY_SAMPLES).fill(null),
        head: 0,
        count: 0,
      });
    }
  }

  /** True when a sample is due at `nowMs` (then call `record` per sector and `commit`). */
  due(nowMs: number): boolean {
    return nowMs >= this.nextSampleAtMs;
  }

  /** Write one sample for `sectorKey` (ignored for a sector not seen at construction). */
  record(sectorKey: string, nowMs: number, holder: string | null, holderShare: number): void {
    const r = this.rings.get(sectorKey);
    if (!r) return;
    r.atMs[r.head] = nowMs;
    r.share[r.head] = holderShare;
    r.holder[r.head] = holder;
    r.head = (r.head + 1) % HISTORY_SAMPLES;
    if (r.count < HISTORY_SAMPLES) r.count++;
  }

  /** Close a sampling round: the next is due HISTORY_SAMPLE_MS later. */
  commit(nowMs: number): void {
    this.nextSampleAtMs = nowMs + HISTORY_SAMPLE_MS;
  }

  /** A sector's samples, oldest first; null for an unknown sector. */
  samples(sectorKey: string): SectorHistorySample[] | null {
    const r = this.rings.get(sectorKey);
    if (!r) return null;
    const out: SectorHistorySample[] = [];
    const start = (r.head - r.count + HISTORY_SAMPLES) % HISTORY_SAMPLES;
    for (let i = 0; i < r.count; i++) {
      const j = (start + i) % HISTORY_SAMPLES;
      out.push({ atMs: r.atMs[j]!, holder: r.holder[j]!, holderShare: Math.round(r.share[j]! * 10) / 10 });
    }
    return out;
  }
}
