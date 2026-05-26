/**
 * @vitest-environment jsdom
 *
 * Probe 5 (mobile-perf-investigation, 2026-05-24) — `?diag=light`
 * volume-reduction mode + 2026-05-26 heap-growth gate step 11 — gate
 * inversion: HIGH_VOLUME_TAGS now drop by default in production, only
 * `?diag=1` / webdriver keep them.
 *
 * The 2026-05-24 captures crossed 14 MB / session, dominated by per-RAF
 * events (rafTick / input_intent / local_pose_*). The d54fne capture
 * analysis (2026-05-26) showed these events drive ~360 obj/sec of
 * allocation pressure even in production mode. The fix gates them at
 * the `logEvent()` boundary so only FULL diag mode keeps them.
 *
 * Suppression list (HIGH_VOLUME_TAGS):
 *   - rafTick
 *   - input_intent
 *   - local_pose_predicted
 *   - local_pose_rendered
 *   - inputSent
 *
 * Contract (post-inversion, 2026-05-26):
 *   - `?diag=1`     → diag enabled, all tags pass through (FULL diag)
 *   - webdriver=true (no flag or `?diag=1`) → all tags (replay harnesses)
 *   - `?diag=light` → diag enabled, high-volume tags suppressed
 *   - `?diag=0`     → diag disabled, high-volume tags suppressed
 *   - absent + non-webdriver → diag off, high-volume tags suppressed
 *
 * Analytical tags (snapshot, correction, raf_gap, raf_stutter,
 * heap_sample, damage_number_*, fire, etc.) are NEVER suppressed —
 * they remain available on every code path for capture-driven
 * debugging and E2E ring inspection.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  logEvent,
  getRingEntries,
  isDiagEnabled,
  isDiagLightMode,
  isFullDiagMode,
  __resetDiagCache,
} from './ClientLogger';

function setSearch(query: string): void {
  // jsdom: replace the URL so isDiagEnabled / isDiagLightMode re-evaluate
  // on the next call (after __resetDiagCache).
  window.history.replaceState({}, '', `/?${query}`);
}

beforeEach(() => {
  __resetDiagCache();
  // Clear the ring buffer for a clean test slate.
  getRingEntries().length = 0; // safe — array is mutable internally
});

describe('?diag=light — volume-reduction mode', () => {
  it('?diag=1 (full): isDiagEnabled=true, isDiagLightMode=false', () => {
    setSearch('diag=1');
    expect(isDiagEnabled()).toBe(true);
    expect(isDiagLightMode()).toBe(false);
  });

  it('?diag=light: isDiagEnabled=true, isDiagLightMode=true', () => {
    setSearch('diag=light');
    expect(isDiagEnabled()).toBe(true);
    expect(isDiagLightMode()).toBe(true);
  });

  it('?diag=0: isDiagEnabled=false, isDiagLightMode=false', () => {
    setSearch('diag=0');
    expect(isDiagEnabled()).toBe(false);
    expect(isDiagLightMode()).toBe(false);
  });

  it('absent diag: isDiagEnabled=false, isDiagLightMode=false', () => {
    setSearch('');
    expect(isDiagEnabled()).toBe(false);
    expect(isDiagLightMode()).toBe(false);
  });

  it('?diag=1: high-volume tags ARE logged (full mode)', () => {
    setSearch('diag=1');
    logEvent('rafTick', { elapsedMs: 11.1 });
    logEvent('input_intent', { tick: 1 });
    logEvent('local_pose_predicted', { x: 0, y: 0 });
    logEvent('local_pose_rendered', { x: 0, y: 0 });
    logEvent('inputSent', { tick: 1 });
    const ring = getRingEntries();
    const tags = ring.map((e) => e.tag);
    expect(tags).toContain('rafTick');
    expect(tags).toContain('input_intent');
    expect(tags).toContain('local_pose_predicted');
    expect(tags).toContain('local_pose_rendered');
    expect(tags).toContain('inputSent');
  });

  it('?diag=light: high-volume tags are SUPPRESSED', () => {
    setSearch('diag=light');
    logEvent('rafTick', { elapsedMs: 11.1 });
    logEvent('input_intent', { tick: 1 });
    logEvent('local_pose_predicted', { x: 0, y: 0 });
    logEvent('local_pose_rendered', { x: 0, y: 0 });
    logEvent('inputSent', { tick: 1 });
    const ring = getRingEntries();
    expect(ring.length, 'all 5 high-volume tags should be suppressed').toBe(0);
  });

  it('?diag=light: ANALYTICAL tags (snapshot/correction/perf) are NOT suppressed', () => {
    setSearch('diag=light');
    logEvent('snapshot_applied', { applyMs: 1.2 });
    logEvent('snapshot_received', { recvGapMs: 49 });
    logEvent('correction', { ticksAhead: 7 });
    logEvent('raf_gap', { elapsedMs: 110 });
    logEvent('raf_stutter', { elapsedMs: 45 });
    logEvent('heap_sample', { heapUsedMb: 50 });
    logEvent('damage_number_scheduled', { tag: 'shot-1' });
    logEvent('recv_gap_long', { recvGapMs: 500 });
    const tags = getRingEntries().map((e) => e.tag);
    expect(tags).toEqual([
      'snapshot_applied',
      'snapshot_received',
      'correction',
      'raf_gap',
      'raf_stutter',
      'heap_sample',
      'damage_number_scheduled',
      'recv_gap_long',
    ]);
  });

  it('?diag=0: high-volume tags are SUPPRESSED (post-inversion 2026-05-26)', () => {
    setSearch('diag=0');
    logEvent('rafTick', { elapsedMs: 11.1 });
    logEvent('input_intent', { tick: 1 });
    logEvent('local_pose_predicted', { x: 0, y: 0 });
    logEvent('local_pose_rendered', { x: 0, y: 0 });
    logEvent('inputSent', { tick: 1 });
    const ring = getRingEntries();
    expect(ring.length, '?diag=0 must drop high-volume tags (production parity)').toBe(0);
  });

  it('absent diag: high-volume tags are SUPPRESSED (post-inversion 2026-05-26)', () => {
    setSearch('');
    logEvent('rafTick', { elapsedMs: 11.1 });
    logEvent('input_intent', { tick: 1 });
    logEvent('local_pose_predicted', { x: 0, y: 0 });
    logEvent('local_pose_rendered', { x: 0, y: 0 });
    logEvent('inputSent', { tick: 1 });
    const ring = getRingEntries();
    expect(ring.length, 'absent diag must drop high-volume tags (production default)').toBe(0);
  });

  it('?diag=0: ANALYTICAL tags are NOT suppressed (only high-volume gated)', () => {
    setSearch('diag=0');
    logEvent('snapshot_applied', { applyMs: 1.2 });
    logEvent('snapshot_received', { recvGapMs: 49 });
    logEvent('correction', { ticksAhead: 7 });
    logEvent('raf_gap', { elapsedMs: 110 });
    logEvent('raf_stutter', { elapsedMs: 45 });
    logEvent('heap_sample', { heapUsedMb: 50 });
    logEvent('damage_number_scheduled', { tag: 'shot-1' });
    logEvent('fire', { tick: 1, shotId: 'shot-1' });
    const tags = getRingEntries().map((e) => e.tag);
    expect(tags).toEqual([
      'snapshot_applied',
      'snapshot_received',
      'correction',
      'raf_gap',
      'raf_stutter',
      'heap_sample',
      'damage_number_scheduled',
      'fire',
    ]);
  });

  it('isFullDiagMode(): true only for ?diag=1 (or webdriver)', () => {
    setSearch('diag=1');
    expect(isFullDiagMode()).toBe(true);
    __resetDiagCache();
    setSearch('diag=light');
    expect(isFullDiagMode()).toBe(false);
    __resetDiagCache();
    setSearch('diag=0');
    expect(isFullDiagMode()).toBe(false);
    __resetDiagCache();
    setSearch('');
    expect(isFullDiagMode()).toBe(false);
  });

  it('VOLUME REDUCTION: in a representative mix, light mode drops ~60% of events', () => {
    setSearch('diag=light');
    // Mix mirroring a real session: per-RAF events at 90Hz × 5s + per-snapshot
    // events at 20Hz × 5s + sporadic combat events.
    for (let i = 0; i < 450; i++) {
      logEvent('rafTick', { elapsedMs: 11 });
      logEvent('local_pose_rendered', { x: i, y: 0 });
    }
    for (let i = 0; i < 300; i++) {
      logEvent('input_intent', { tick: i });
      logEvent('local_pose_predicted', { tick: i, x: i, y: 0 });
    }
    for (let i = 0; i < 100; i++) {
      logEvent('snapshot_applied', { applyMs: 1.2 });
      logEvent('snapshot_received', { recvGapMs: 49 });
    }
    for (let i = 0; i < 20; i++) {
      logEvent('fire', { tick: i, shotId: `shot-${i}` });
    }
    // Expected: all 1500 high-volume events suppressed (450×2 + 300×2 = 1500),
    // only the 220 analytical events remain (100×2 + 20 = 220).
    const ring = getRingEntries();
    expect(ring.length).toBeLessThanOrEqual(220);
    expect(ring.every((e) =>
      ['snapshot_applied', 'snapshot_received', 'fire'].includes(e.tag),
    )).toBe(true);
  });
});
