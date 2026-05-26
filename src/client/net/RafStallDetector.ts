/**
 * Per-RAF heap + frame-gap diagnostics. Lifted out of
 * `ColyseusClient.tickPhysics` so the hot path reads as
 * "process pending snapshot -> sample stalls -> tick" rather than
 * burying the diagnostic instrumentation in the middle of the loop.
 *
 *   - `sampleHeapIfDue` runs at ~10 Hz (every 6 RAFs at 60 Hz) and
 *     emits a `heap_sample` event with the rolling swarm-decode cost
 *     window. The mobile-perf-investigation review bumped from 1 Hz
 *     to 10 Hz so the GC sawtooth between 110 ms stalls is visible.
 *
 *   - `detectGap` watches the inter-RAF interval:
 *       * 30 ms < elapsed ≤ 100 ms → `raf_stutter` (perceptible at
 *         90 Hz; the user's felt "lag spikes" are mostly here).
 *       * elapsed > 100 ms → `raf_gap` (large stalls; ~10/min on the
 *         mobile-capture n6uznw repro) with heap + ms-since-last-stall
 *         delta so a capture can attribute it to GC vs. compositor.
 *
 *   - `recordSwarmDecode` is called once per binary-swarm packet decode
 *     so the next `heap_sample` reports the rolling max + avg + count.
 *
 * Owns the 6 fields previously inline on ColyseusClient
 * (`_rafSampleCounter`, `_swarmDecodeMax/Total/CountMs`,
 * `_lastRafStallAtMs`, `_lastRafStallHeapMb`).
 */

import { logEvent } from '../debug/ClientLogger';
import { readHeapUsedMb } from './perfStats';

export class RafStallDetector {
  private rafSampleCounter = 0;
  private swarmDecodeMaxMs = 0;
  private swarmDecodeTotalMs = 0;
  private swarmDecodeCount = 0;
  private lastRafStallAtMs = -1;
  private lastRafStallHeapMb = -1;

  recordSwarmDecode(decodeMs: number): void {
    this.swarmDecodeTotalMs += decodeMs;
    this.swarmDecodeCount += 1;
    if (decodeMs > this.swarmDecodeMaxMs) this.swarmDecodeMaxMs = decodeMs;
  }

  /**
   * Run every RAF. Emits `heap_sample` at ~10 Hz (every 6th call)
   * with the rolling swarm-decode window since the last sample, then
   * resets the window so the next sample reports cost-since-last.
   */
  sampleHeapIfDue(): void {
    this.rafSampleCounter++;
    if (this.rafSampleCounter < 6) return;
    this.rafSampleCounter = 0;
    const heap = readHeapUsedMb();
    if (heap === undefined) return;
    logEvent('heap_sample', {
      heapUsedMb: parseFloat(heap.toFixed(2)),
      swarmDecodeMaxMs: this.swarmDecodeMaxMs > 0
        ? parseFloat(this.swarmDecodeMaxMs.toFixed(2))
        : undefined,
      swarmDecodeAvgMs: this.swarmDecodeCount > 0
        ? parseFloat((this.swarmDecodeTotalMs / this.swarmDecodeCount).toFixed(2))
        : undefined,
      swarmDecodeCount: this.swarmDecodeCount,
    });
    this.swarmDecodeMaxMs = 0;
    this.swarmDecodeTotalMs = 0;
    this.swarmDecodeCount = 0;
  }

  /**
   * Inspect the just-observed RAF gap. Emits `raf_stutter` for 30-100 ms
   * intervals; `raf_gap` for > 100 ms with heap + delta-since-last-stall.
   */
  detectGap(elapsedMs: number, inputTickBefore: number, nowMs: number): void {
    if (elapsedMs > 30 && elapsedMs <= 100) {
      logEvent('raf_stutter', {
        elapsedMs: Math.round(elapsedMs * 100) / 100,
        inputTickBefore,
      });
    }
    if (elapsedMs > 100) {
      const heap = readHeapUsedMb();
      const heapVal = heap !== undefined ? parseFloat(heap.toFixed(2)) : null;
      const msSinceLastStall = this.lastRafStallAtMs >= 0
        ? Math.round(nowMs - this.lastRafStallAtMs)
        : -1;
      const heapDelta = (heap !== undefined && this.lastRafStallHeapMb >= 0)
        ? parseFloat((heap - this.lastRafStallHeapMb).toFixed(2))
        : null;
      logEvent('raf_gap', {
        elapsedMs: Math.round(elapsedMs * 100) / 100,
        inputTickBefore,
        heapUsedMb: heapVal,
        msSinceLastStall,
        heapDeltaMbSinceLastStall: heapDelta,
      });
      this.lastRafStallAtMs = nowMs;
      if (heap !== undefined) this.lastRafStallHeapMb = heap;
    }
  }
}
