/**
 * Unit tests for the rolling 30-s health-stats aggregator
 * (plan: quirky-rabbit, Phase 6).
 *
 * The aggregator is fed by two independent producers (longtask
 * observer + Colyseus `gc_pause` message handler) and read once per
 * second by the publisher. These tests lock:
 *   - Each window is independent.
 *   - The window slides — events older than 30 s drop out.
 *   - max() across the window tracks the largest in-window duration.
 *   - Ring overflow wraps cleanly (oldest entries get overwritten).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordServerGcPause,
  recordLongtask,
  getHealthStats,
  _resetHealthStatsForTests,
} from './healthStats.js';

describe('healthStats', () => {
  beforeEach(() => {
    _resetHealthStatsForTests();
  });

  it('reports zero counts when no events have been recorded', () => {
    const s = getHealthStats(1000);
    expect(s.serverGc.count30s).toBe(0);
    expect(s.serverGc.maxMs30s).toBe(0);
    expect(s.longtask.count30s).toBe(0);
    expect(s.longtask.maxMs30s).toBe(0);
  });

  it('serverGc and longtask windows are independent', () => {
    recordServerGcPause(15, 1000);
    recordLongtask(80, 1000);
    const s = getHealthStats(1000);
    expect(s.serverGc.count30s).toBe(1);
    expect(s.serverGc.maxMs30s).toBe(15);
    expect(s.longtask.count30s).toBe(1);
    expect(s.longtask.maxMs30s).toBe(80);
  });

  it('window slides — events older than 30 s drop from the count', () => {
    recordServerGcPause(8, 1000);
    recordServerGcPause(12, 5000);
    // At t=10s, both events are in the 30 s window.
    expect(getHealthStats(10_000).serverGc.count30s).toBe(2);
    // At t=35s, the t=1000 event is outside (35 - 1 = 34 s ago); the
    // t=5000 event is inside (35 - 5 = 30 s ago, at the cutoff).
    // Cutoff = nowMs - WINDOW_MS = 5000, t < cutoff is t < 5000.
    // t=1000 < 5000 → drop. t=5000 NOT < 5000 → keep.
    expect(getHealthStats(35_000).serverGc.count30s).toBe(1);
    // At t=36s, the t=5000 event also drops (cutoff = 6000, t=5000 < 6000).
    expect(getHealthStats(36_000).serverGc.count30s).toBe(0);
  });

  it('maxMs30s tracks the largest in-window duration, ignores out-of-window', () => {
    recordLongtask(200, 1000); // big, but will fall out
    recordLongtask(60, 20_000);
    recordLongtask(110, 25_000);
    // At t=25s the big 200 ms event is still in window.
    expect(getHealthStats(25_000).longtask.maxMs30s).toBe(200);
    // At t=40s the big event has dropped; max is now 110.
    expect(getHealthStats(40_000).longtask.maxMs30s).toBe(110);
  });

  it('ring overflow wraps without crashing or double-counting', () => {
    // Capacity is 256; record 300 events all at the same nowMs so they
    // all land within the 30 s window after wrap.
    const t = 1000;
    for (let i = 0; i < 300; i++) recordLongtask(50 + i, t);
    // After wrap, the ring holds the most recent 256 events. Their
    // durations are 50+44 .. 50+299 (the first 44 got overwritten).
    // count30s caps at the ring capacity.
    const s = getHealthStats(t);
    expect(s.longtask.count30s).toBe(256);
    expect(s.longtask.maxMs30s).toBe(50 + 299);
  });
});
