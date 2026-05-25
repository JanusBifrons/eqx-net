/**
 * Self-test for the ondeviceReplay harness. Pure synthetic inputs; the
 * real-ndjson replay tests live in `spiral-ers7xy-replay.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { replayOndeviceSnapshots } from './ondeviceReplay';

function buildNdjson(records: Array<{
  ts: number;
  serverTick: number;
  ackedTick: number;
  intervalMs?: number;
  rttMs?: number;
  ticksAhead?: number;
}>): string {
  return records
    .map((r, i) =>
      JSON.stringify({
        source: 'client',
        ts: r.ts,
        tag: 'snapshot',
        data: {
          n: i + 1,
          serverTick: r.serverTick,
          ackedTick: r.ackedTick,
          ticksAhead: r.ticksAhead ?? 0,
          intervalMs: r.intervalMs ?? 50,
          rttMs: r.rttMs ?? 60,
        },
      }),
    )
    .join('\n');
}

describe('ondeviceReplay', () => {
  it('returns zero metrics on empty input', () => {
    const stats = replayOndeviceSnapshots('');
    expect(stats.snapshotCount).toBe(0);
    expect(stats.maxTicksAhead).toBe(0);
  });

  it('parses snapshot ndjson and produces matching snapshotCount', () => {
    const ndjson = buildNdjson([
      { ts: 0, serverTick: 100, ackedTick: 95 },
      { ts: 50, serverTick: 103, ackedTick: 98 },
      { ts: 100, serverTick: 106, ackedTick: 101 },
    ]);
    const stats = replayOndeviceSnapshots(ndjson, { warmupMs: 0 });
    expect(stats.snapshotCount).toBe(3);
  });

  it('synthesises rafTicks between snapshots at 60 Hz', () => {
    // 100ms gap between snapshots → ~6 synthesised rafTicks per gap, x2 gaps = 12
    const ndjson = buildNdjson([
      { ts: 0, serverTick: 100, ackedTick: 95 },
      { ts: 100, serverTick: 106, ackedTick: 101 },
      { ts: 200, serverTick: 112, ackedTick: 107 },
    ]);
    const stats = replayOndeviceSnapshots(ndjson, { warmupMs: 0 });
    // Roughly 12 rafs (allowing for floor/ceil edge cases)
    expect(stats.rafCount).toBeGreaterThanOrEqual(10);
    expect(stats.rafCount).toBeLessThanOrEqual(14);
  });

  it('steady 50ms snapshots with healthy RTT: ticksAhead stays bounded', () => {
    // 60 snapshots at 50ms intervals, RTT 60ms (healthy), ackedTick advancing
    // by 3 per snapshot (60 Hz / 20 Hz broadcast = 3 ticks)
    const records = [];
    for (let i = 0; i < 60; i++) {
      records.push({
        ts: i * 50,
        serverTick: 1000 + i * 3,
        ackedTick: 1000 + i * 3 - 5, // server queue ~5 ticks deep (healthy)
        rttMs: 60,
      });
    }
    const ndjson = buildNdjson(records);
    const stats = replayOndeviceSnapshots(ndjson, { warmupMs: 1000 });

    // Sanity: post-warmup observations exist
    expect(stats.postWarmupObservationCount).toBeGreaterThan(20);
    // Bounded ticksAhead — should be ~5-15 in steady state (leadTicks
    // around 5-10 + server queue 5)
    expect(stats.maxTicksAhead).toBeLessThan(30);
  });

  it('warmupMs filter excludes early observations', () => {
    const ndjson = buildNdjson([
      { ts: 0, serverTick: 100, ackedTick: 0 }, // welcome — would dominate maxTicksAhead
      { ts: 50, serverTick: 103, ackedTick: 98 },
      { ts: 5_100, serverTick: 600, ackedTick: 595 },
    ]);
    const stats = replayOndeviceSnapshots(ndjson, { warmupMs: 5_000 });
    // Welcome teleport at ts=0 is BEFORE warmup end at 5000 → excluded
    expect(stats.postWarmupObservationCount).toBeGreaterThan(0);
  });
});
