/**
 * The 2026-11-21 4G phone capture as a replayable delivery list
 * (fixture `capture-2026-11-21`, loaded through ondeviceReplay.ts).
 * Counts only: snapshots kept, gaps over 200 ms, largest gap, order.
 */
import { describe, it, expect } from 'vitest';
import { captureToDeliveries, loadCaptureFixture } from './ondeviceReplay.js';
import type { Delivery } from './types.js';

const FIXTURE = 'capture-2026-11-21';
/** All JSON snapshots the client logged: one segment per join. */
const KEPT_PER_SEGMENT = [314, 34, 1565];
const KEPT_TOTAL = 1913;
/** Gaps inside segments (the first snapshot of each join has none). */
const GAP_COUNT = 1910;
const LONG_GAP_MS = 200;
const LONG_GAPS = 14;
const LARGEST_GAP_MS = 625.6;
/** Server-tick steps of 3 (one JSON snapshot per 3 ticks, none skipped). */
const TICK_STEP_3_COUNT = 1779;
const JSON_EVERY_TICKS = 3;
const BASE_DELAY_MS = 40;
/** Delivery lists start at this server tick (as runner.ts). */
const START_SERVER_TICK = 100;
const GAP_PRECISION_DIGITS = 6;
const FLOAT_EPSILON_MS = 1e-9;

function gapsMs(list: ReadonlyArray<Delivery>): number[] {
  const out: number[] = [];
  for (let i = 1; i < list.length; i++) out.push(list[i]!.arriveMs - list[i - 1]!.arriveMs);
  return out;
}

describe('capture-2026-11-21 fixture', () => {
  const segments = captureToDeliveries(loadCaptureFixture(FIXTURE));
  const gaps = segments.flatMap(gapsMs);

  it('keeps every logged JSON snapshot, one segment per join', () => {
    expect(segments.map((s) => s.length)).toEqual(KEPT_PER_SEGMENT);
    expect(segments.reduce((n, s) => n + s.length, 0)).toBe(KEPT_TOTAL);
    expect(gaps.length).toBe(GAP_COUNT);
  });

  it('has the capture gaps: 14 over 200 ms, largest 625.6 ms', () => {
    expect(gaps.filter((g) => g > LONG_GAP_MS).length).toBe(LONG_GAPS);
    expect(Math.max(...gaps)).toBeCloseTo(LARGEST_GAP_MS, GAP_PRECISION_DIGITS);
  });

  it('is a well-formed json delivery list: ordered, causal, ticks mostly 3 apart', () => {
    let step3 = 0;
    for (const list of segments) {
      expect(list[0]!.serverTick).toBe(START_SERVER_TICK);
      list.forEach((d, i) => {
        expect(d.stream).toBe('json');
        expect(d.seq).toBe(i);
        expect(d.arriveMs - d.sendMs).toBeGreaterThanOrEqual(BASE_DELAY_MS - FLOAT_EPSILON_MS);
        if (i > 0) {
          expect(d.arriveMs).toBeGreaterThanOrEqual(list[i - 1]!.arriveMs);
          if (d.serverTick - list[i - 1]!.serverTick === JSON_EVERY_TICKS) step3++;
        }
      });
      expect(Math.min(...list.map((d) => d.arriveMs - d.sendMs))).toBeCloseTo(BASE_DELAY_MS, GAP_PRECISION_DIGITS);
    }
    expect(step3).toBe(TICK_STEP_3_COUNT);
  });

  it('replays identically: two loads give the same delivery list', () => {
    const again = captureToDeliveries(loadCaptureFixture(FIXTURE));
    expect(again).toEqual(segments);
    expect(JSON.stringify(again)).toBe(JSON.stringify(segments));
  });
});
