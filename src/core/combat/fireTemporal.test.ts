/**
 * Regression lock — fire-claim temporal resolution (`clampFireTick`).
 *
 * THE BUG (on-device, diagnostic capture
 * `2026-05-19T11-22-22-628Z-uf0o8g`, user: "loads of lag, lots of shot
 * rejected"). Per-event reconstruction of that capture's combat log:
 * the client fires at exactly weapon cadence (118× Δ10 client-ticks);
 * **46 / 125 fires (37%) rejected**; the rejected shots'
 * `tick − lastAcceptedClientTick` grows monotonically 10, 20, 30 … 420
 * — a long *consecutive-reject run* with `lastFireClientTick` frozen.
 * The cooldown path cannot do that (Δ ≥ 10 ⇒ `tick − last < 10` is
 * false ⇒ it would ACCEPT). The only path that rejects a whole
 * growing-Δ run is **temporal plausibility**: `serverTick − tick >
 * LAG_COMP_WINDOW`. After a main-thread stall (the capture has 6
 * `longtask`s + the user's phone call) the client's wall-clock-anchored
 * `inputTick` falls BEHIND `serverTick` and recovers slowly (catch-up
 * capped at 4 ticks/RAF), so every held-fire during recovery is
 * timestamped with a too-old tick and HARD-REJECTED until it catches
 * back up. Real shots, mis-timestamped by a lagged input clock,
 * silently dropped — the felt "shot rejected".
 *
 * THE FIX, locked here: do not reject a stale claim — CLAMP it to the
 * lag-comp window floor (`serverTick − lagCompWindow`) and resolve the
 * shot against the oldest available SnapshotRing pose. The rewind is
 * bounded identically to a legitimate edge-of-window claim, so there is
 * no abuse advantage and no extra rewind cost; the cooldown rate-limit
 * (separate, client-tick spacing) is unchanged. Future claims (client
 * running ahead — the steady-state here, `input_received` tickDelta
 * ≈ −90..−115) pass through untouched so the already-correct
 * client-ahead path (getPoseAt(future) → shipPoseCache fallback) is
 * not perturbed.
 *
 * Pure + exhaustive (the `shouldDetachWarpVisual` / `LocalBeam`
 * precedent: the side-effecting `SectorRoom.handleFire` defers to this).
 */
import { describe, it, expect } from 'vitest';
import { clampFireTick } from './fireTemporal.js';

const W = 12; // LAG_COMP_WINDOW

describe('clampFireTick — never reject; clamp stale claims to the lag-comp floor', () => {
  it('a current claim (tick === serverTick) is unchanged', () => {
    expect(clampFireTick(1000, 1000, W)).toBe(1000);
  });

  it('a claim exactly at the window floor is unchanged (boundary, inclusive)', () => {
    expect(clampFireTick(1000 - W, 1000, W)).toBe(1000 - W);
  });

  it('a claim one tick past the floor is clamped UP to the floor (NOT rejected)', () => {
    expect(clampFireTick(1000 - W - 1, 1000, W)).toBe(1000 - W);
  });

  it('a very stale claim (the capture: ~420 ticks behind) clamps to the floor, never dropped', () => {
    expect(clampFireTick(1000 - 420, 1000, W)).toBe(1000 - W);
  });

  it('a future claim (client running ahead — the steady state) passes through untouched', () => {
    // input_received tickDelta ≈ −90..−115 ⇒ client ~90-115 ticks ahead.
    expect(clampFireTick(1100, 1000, W)).toBe(1100);
  });

  it('result is ALWAYS ≥ serverTick − lagCompWindow (rewind bounded ⇒ no abuse advantage)', () => {
    for (const claimed of [-10_000, 0, 880, 988, 1000, 5000]) {
      expect(clampFireTick(claimed, 1000, W)).toBeGreaterThanOrEqual(1000 - W);
    }
  });

  it('REGRESSION: the post-stall recovery run — every fire resolves (zero dropped)', () => {
    // Client recovering after a stall: serverTick steady at 1000, the
    // client fires at L+10, L+20, … far below serverTick−W (the capture's
    // monotonically-growing rejected-Δ signature). OLD code rejected
    // every one; the clamp must yield a usable rewind tick for ALL.
    const serverTick = 1000;
    const L = 500; // last accepted, long behind
    for (let i = 1; i <= 50; i++) {
      const claimed = L + i * 10; // 510, 520, … 1000 — many are < serverTick−W
      const eff = clampFireTick(claimed, serverTick, W);
      // Never "rejected": always a usable tick within the rewind window.
      expect(eff).toBeGreaterThanOrEqual(serverTick - W);
      expect(eff).toBeLessThanOrEqual(Math.max(serverTick, claimed));
      // The stale ones specifically resolve at the floor (not dropped).
      if (claimed < serverTick - W) expect(eff).toBe(serverTick - W);
    }
  });
});
