/**
 * Self-tests for the harness network model (gaps, bursts, jitter, frame
 * stalls). Pure and seeded: counts and orders only, no wall-clock time.
 */
import { describe, it, expect } from 'vitest';
import { buildDeliveries, buildFrameTimes, buildNetworkEvents, runScenario } from './runner.js';
import { GAP_AT_MS, GAP_PROFILES, getGapProfile } from './gapProfiles.js';
import type { Delivery, NetStream } from './types.js';

const DURATION_MS = 6000;
/** Base one-way delay of the WAN profiles (gapProfiles.ts). */
const WAN_DELAY = 40;

function sentDuring(ds: Delivery[], stream: NetStream, fromMs: number, toMs: number): Delivery[] {
  return ds.filter((d) => d.stream === stream && d.sendMs >= fromMs && d.sendMs < toMs);
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? Number.NaN;
}

describe('network gap model', () => {
  it('a 400 ms stall delivers its packets at the end, in send order', () => {
    const ds = buildDeliveries(getGapProfile('gap-400'), DURATION_MS);
    const endMs = GAP_AT_MS + 400 + WAN_DELAY;
    for (const stream of ['json', 'swarm'] as const) {
      const held = sentDuring(ds, stream, GAP_AT_MS, GAP_AT_MS + 400);
      expect(held.length).toBe(stream === 'json' ? 8 : 24);
      for (const d of held) expect(d.arriveMs).toBe(endMs);
      const inStream = ds.filter((d) => d.stream === stream);
      const seqs = inStream.map((d) => d.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      // Nothing from this stream arrives inside the stall.
      expect(inStream.filter((d) => d.arriveMs > GAP_AT_MS + WAN_DELAY && d.arriveMs < endMs).length).toBe(0);
    }
  });

  it('the same seed gives the same delivery list on two runs', () => {
    for (const p of Object.values(GAP_PROFILES)) {
      expect(buildDeliveries(p, DURATION_MS)).toEqual(buildDeliveries(p, DURATION_MS));
    }
    const other = { ...getGapProfile('jitter-4g'), seed: 12345 };
    expect(buildDeliveries(other, DURATION_MS)).not.toEqual(buildDeliveries(getGapProfile('jitter-4g'), DURATION_MS));
  });

  it('single-stream gaps stall only that stream', () => {
    const json = buildDeliveries(getGapProfile('gap-json-only'), DURATION_MS);
    expect(sentDuring(json, 'swarm', GAP_AT_MS, GAP_AT_MS + 400).every((d) => d.arriveMs === d.sendMs + WAN_DELAY)).toBe(true);
    expect(sentDuring(json, 'json', GAP_AT_MS, GAP_AT_MS + 400).every((d) => d.arriveMs === GAP_AT_MS + 400 + WAN_DELAY)).toBe(true);
    const swarm = buildDeliveries(getGapProfile('gap-swarm-only'), DURATION_MS);
    expect(sentDuring(swarm, 'json', GAP_AT_MS, GAP_AT_MS + 400).every((d) => d.arriveMs === d.sendMs + WAN_DELAY)).toBe(true);
    expect(sentDuring(swarm, 'swarm', GAP_AT_MS, GAP_AT_MS + 400).every((d) => d.arriveMs === GAP_AT_MS + 400 + WAN_DELAY)).toBe(true);
  });

  it('lan-clean has no stalls: every packet arrives after the base delay', () => {
    const ds = buildDeliveries(getGapProfile('lan-clean'), DURATION_MS);
    expect(ds.filter((d) => d.arriveMs !== d.sendMs + 2).length).toBe(0);
    expect(buildFrameTimes(getGapProfile('lan-clean'), DURATION_MS).length).toBe(360);
  });

  it('frame-stall-250 fires no frame inside the stall and one at its end', () => {
    const frames = buildFrameTimes(getGapProfile('frame-stall-250'), DURATION_MS);
    expect(frames.filter((t) => t >= GAP_AT_MS && t < GAP_AT_MS + 250).length).toBe(0);
    expect(frames.filter((t) => t === GAP_AT_MS + 250).length).toBe(1);
  });

  it('jitter-4g JSON inter-arrival gaps land near the capture percentiles', () => {
    const ds = buildDeliveries(getGapProfile('jitter-4g'), 60_000).filter((d) => d.stream === 'json');
    const gaps: number[] = [];
    let prevArrive = ds[0]?.arriveMs ?? 0;
    for (const d of ds.slice(1)) {
      gaps.push(d.arriveMs - prevArrive);
      prevArrive = d.arriveMs;
    }
    gaps.sort((a, b) => a - b);
    expect(Math.abs(percentile(gaps, 0.5) - 52)).toBeLessThanOrEqual(3);
    expect(Math.abs(percentile(gaps, 0.95) - 91)).toBeLessThanOrEqual(5);
    expect(Math.abs(percentile(gaps, 0.99) - 170)).toBeLessThanOrEqual(10);
  });

  it('profiles drive the existing runner', () => {
    const obs = runScenario(buildNetworkEvents(getGapProfile('gap-600'), DURATION_MS));
    expect(obs.filter((o) => o.event === 'snapshot').length).toBeGreaterThan(0);
    expect(obs.filter((o) => o.ticksAhead < 0).length).toBe(0);
  });
});
