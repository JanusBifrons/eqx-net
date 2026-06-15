/**
 * Selection-scoped live-stats channel (structures follow-up Item B5).
 *
 * Decision logic over injected hooks — the same testable shape as
 * `TransitOrchestrator` (no live Colyseus room needed). Tracks each connection's
 * currently-selected entity and, on a low-frequency `tick()` (driven by the
 * room's own ~5 Hz timer, OFF the snapshot/physics hot path), resolves the
 * entity's live stats and pushes `entity_stats` to ONLY the selecting client.
 *
 * Lifecycle (no 5 Hz leaks — the whole reason this is its own subsystem):
 *   - `select(sessionId, id, kind)` registers / replaces the selection.
 *   - `deselect(sessionId)` removes it.
 *   - `clearSession(sessionId)` removes it on disconnect / transit (onLeave).
 *   - `tick()` auto-removes any selection whose entity no longer resolves
 *     (death / despawn) — `resolveStats` returns null ⇒ the selection is dropped
 *     and no further emits happen for it.
 *
 * Only PLAYER SHIPS and STRUCTURES flow here; drones read health from
 * the render mirror client-side, so they never call `select`.
 */
import type { EntityStatsMessage } from '../../shared-types/messages/selectionMessages.js';

export type SelectionKind = 'ship' | 'structure';

export interface Selection {
  id: string;
  kind: SelectionKind;
}

export interface SelectionStatsHooks {
  /** Resolve the live stats for a selection, or null when the entity is gone
   *  (dead / despawned / not found). Returning null auto-clears the selection. */
  resolveStats(sel: Selection): EntityStatsMessage | null;
  /** Push an `entity_stats` message to exactly one connection. */
  sendTo(sessionId: string, msg: EntityStatsMessage): void;
}

export class SelectionStatsSubsystem {
  private readonly bySession = new Map<string, Selection>();

  constructor(private readonly hooks: SelectionStatsHooks) {}

  /** Register/replace `sessionId`'s selection. */
  select(sessionId: string, id: string, kind: SelectionKind): void {
    this.bySession.set(sessionId, { id, kind });
  }

  /** Clear `sessionId`'s selection (explicit deselect). */
  deselect(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /** Clear on disconnect / transit (onLeave). Idempotent. */
  clearSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /** Number of live selections (test/diagnostic surface — leak check). */
  get activeCount(): number {
    return this.bySession.size;
  }

  /** ~5 Hz emit. Resolves each selection; sends stats or drops the dead one. */
  tick(): void {
    if (this.bySession.size === 0) return;
    // Collect dead selections to delete after iteration (no mutate-while-iterate).
    let dead: string[] | null = null;
    for (const [sessionId, sel] of this.bySession) {
      const stats = this.hooks.resolveStats(sel);
      if (stats === null) {
        (dead ??= []).push(sessionId);
        continue;
      }
      this.hooks.sendTo(sessionId, stats);
    }
    if (dead !== null) {
      for (const s of dead) this.bySession.delete(s);
    }
  }
}
