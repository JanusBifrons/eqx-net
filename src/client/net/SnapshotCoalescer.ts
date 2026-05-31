/**
 * Probe-6 snapshot coalescing — collapse the WebSocket's burst-after-pause
 * delivery into a single newest-wins apply.
 *
 * When the main thread is paused (GC, long task, scroll, sleep-wake) the
 * Colyseus WebSocket queues every snapshot that arrived during the pause
 * and delivers them as a synchronous burst. Applying all of them spends
 * O(N) main-thread work catching up to a state the SECOND snapshot would
 * have given us, since snapshots are full-state (not deltas). Coalescing
 * stores only the newest pending snap; the count of dropped intermediates
 * is logged for diagnostic visibility.
 *
 * Called from two sites:
 *   - `room.onMessage('snapshot')` — calls `enqueue(snap)` which either
 *     defers (default) or applies immediately (legacy `?coalesce=0`).
 *   - `tickPhysics()` — calls `drain(onApply)` once per RAF to release
 *     the pending snap to the apply path.
 *
 * Locked by `src/client/net/snapshotCoalesce.test.ts`.
 */

import type { SnapshotMessage } from '@shared-types/messages';
import { logEvent } from '../debug/ClientLogger.js';

export class SnapshotCoalescer {
  private pending: SnapshotMessage | null = null;
  private droppedSinceLastDrain = 0;

  constructor(private readonly enabled: boolean) {}

  /** True when coalescing is on (default). `?coalesce=0` flips this. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Enqueue a freshly-received snapshot. When coalescing is disabled,
   * the caller (onMessage handler) is expected to apply immediately
   * after checking `isEnabled() === false`. When enabled, the prior
   * pending snap is discarded (newer supersedes; full-state, not deltas)
   * and `droppedSinceLastDrain` is incremented.
   */
  enqueue(snap: SnapshotMessage): void {
    if (!this.enabled) return;
    if (this.pending !== null) {
      this.droppedSinceLastDrain++;
    }
    this.pending = snap;
  }

  /**
   * Drain the pending snapshot. The caller passes `onApply` (typically
   * `applySnapshotNow`); the coalescer invokes it with the newest snap
   * and emits a `snapshot_coalesced` log event when any drops occurred
   * in the window. No-op when nothing pending OR coalescing disabled.
   */
  drain(onApply: (snap: SnapshotMessage) => void): void {
    if (!this.enabled || this.pending === null) return;
    const snap = this.pending;
    this.pending = null;
    const dropped = this.droppedSinceLastDrain;
    this.droppedSinceLastDrain = 0;
    if (dropped > 0) {
      logEvent('snapshot_coalesced', {
        dropped,
        newestServerTick: snap.serverTick,
      });
    }
    onApply(snap);
  }

  /** For diagnostics / tests: peek at the count without resetting. */
  peekDroppedCount(): number {
    return this.droppedSinceLastDrain;
  }

  /**
   * Plan: crispy-kazoo, Commit 6 — drop any pending snapshot so a
   * GameSurface remount doesn't inherit stale state.
   */
  dispose(): void {
    this.pending = null;
    this.droppedSinceLastDrain = 0;
  }
}
