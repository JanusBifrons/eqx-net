/**
 * 1Hz HUD-store dispatcher — step 10 of the perf-floor GC-discipline ship.
 *
 * Per-event handlers (`handleDamage`, `handleShield`, the binary-swarm
 * decoder) stash the latest hull/shield/swarm-count values here; this
 * module drains them to Zustand at most once per second, dedupes
 * unchanged values, and lets the HUD bar's 1s CSS transition animate
 * smoothly between samples.
 *
 * Why a separate module:
 *   - Keeps the Zustand `setHullPct`/`setShieldPct`/`setSwarmCount`
 *     writes off the per-frame budget (Zustand purity #2: discrete UI
 *     scalars OK; per-frame setters cause 60 Hz React re-renders).
 *   - Single dispatch site, easy to lock with a unit test.
 *   - The MirrorUpdater extraction (commit 16 of the v3 plan) will
 *     compose this directly; for now it's owned by ColyseusClient.
 *
 * The renderer-subscribes-to-bus rule (src/client/CLAUDE.md) is bypassed
 * here deliberately: this is a WRITE (not a subscribe), and the 1Hz rate
 * keeps it off the per-frame budget.
 */

import { useUIStore } from '../state/store.js';

export class HudDispatcher {
  private static readonly DISPATCH_INTERVAL_MS = 1000;

  private pendingHullPct = -1;
  private pendingShieldPct = -1;
  private lastPushedHullPct = -1;
  private lastPushedShieldPct = -1;
  private lastDispatchAtMs = -1;
  private lastPushedSwarmCount = -1;

  /** Stash the latest hull % (called from damage handler). Coalesces. */
  stashHull(pct: number): void {
    this.pendingHullPct = pct;
  }

  /** Stash the latest shield % (damage + shield-event handlers). */
  stashShield(pct: number): void {
    this.pendingShieldPct = pct;
  }

  /**
   * Swarm count is dispatched at binary-packet cadence (60 Hz), NOT
   * 1Hz — but is deduped on value-change-only so a stationary swarm
   * doesn't fire every packet. Pushed immediately (not coalesced) so
   * the HUD doesn't show a stale count after a wave completes.
   */
  pushSwarmCount(count: number): void {
    if (count !== this.lastPushedSwarmCount) {
      this.lastPushedSwarmCount = count;
      useUIStore.getState().setSwarmCount(count);
    }
  }

  /**
   * Called once per frame from updateMirror. Drains pending hull/shield
   * to Zustand when the 1Hz window has elapsed. Dedupe (against last-
   * pushed) suppresses no-op setter calls. Negative pending values are
   * treated as "no event yet" and skipped.
   */
  tick(nowMs: number): void {
    if (nowMs - this.lastDispatchAtMs < HudDispatcher.DISPATCH_INTERVAL_MS) return;
    this.lastDispatchAtMs = nowMs;
    if (this.pendingHullPct !== this.lastPushedHullPct && this.pendingHullPct >= 0) {
      this.lastPushedHullPct = this.pendingHullPct;
      useUIStore.getState().setHullPct(this.pendingHullPct);
    }
    if (this.pendingShieldPct !== this.lastPushedShieldPct && this.pendingShieldPct >= 0) {
      this.lastPushedShieldPct = this.pendingShieldPct;
      useUIStore.getState().setShieldPct(this.pendingShieldPct);
    }
  }

  /**
   * Plan: crispy-kazoo, Commit 6 — reset every state surface so a
   * GameSurface remount sees a clean dispatcher. No RAF / timeout is
   * outstanding here (the dispatcher is pure-pull), so dispose is a
   * simple field-zero — but kept as a method so the dispose-audit
   * test can mark this subsystem cleared without inspecting fields.
   */
  dispose(): void {
    this.pendingHullPct = -1;
    this.pendingShieldPct = -1;
    this.lastPushedHullPct = -1;
    this.lastPushedShieldPct = -1;
    this.lastDispatchAtMs = -1;
    this.lastPushedSwarmCount = -1;
  }
}
