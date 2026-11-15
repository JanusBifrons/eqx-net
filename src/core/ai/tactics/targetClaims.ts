/**
 * Spread targets (owner decision 2026-11-14): "each NPC prefers an enemy nobody
 * else is already shooting, so a 3v3 breaks into three duels … Gang-ups still
 * happen when one side is outnumbered."
 *
 * `TargetClaimBoard` holds each brain's current body target, per NPC side, and
 * the running count per (side, target). A brain drops its claim at the start
 * of its tick and re-claims after its pick, so during the pick the count is
 * exactly how many OTHER brains of its side hold each candidate. Brains tick in
 * registration order and update the board as they go, so on the first tick of
 * a fight three attackers fan out over three targets instead of all taking the
 * nearest and then all switching together (a counted-once-per-tick array would
 * flip them in unison). Deterministic: same registration order, same claims.
 *
 * Owned by `AiController` (`view.claims`). Alloc-free on the hot path: a claim
 * is a Map lookup + set on existing keys; only a target id seen for the first
 * time adds an entry (kept at 0 afterwards, removed when that id leaves the
 * world via `forgetTarget`).
 */
import type { IAiTargetClaims } from '../../contracts/IAiBehaviour.js';

/** How much each ally already on a target worsens its pick score
 *  (`score × (1 + weight × allies)`, score ∝ distance²). 4 ⇒ a target one
 *  ally holds loses to a free one up to √5 ≈ 2.2× as far. */
export const TARGET_CLAIM_WEIGHT = 4;

export class TargetClaimBoard implements IAiTargetClaims {
  /** side → target id → brains of that side holding it. */
  private readonly counts = new Map<string, Map<string, number>>();
  /** entity id → its claimed target (null = none) and side. */
  private readonly targetOf = new Map<string, string | null>();
  private readonly sideOf = new Map<string, string>();

  claim(entityId: string, side: string, targetId: string | null): void {
    const prev = this.targetOf.get(entityId);
    const prevSide = this.sideOf.get(entityId);
    if (prev === targetId && prevSide === side) return;
    if (prev != null && prevSide !== undefined) this.bump(prevSide, prev, -1);
    if (prevSide !== side) this.sideOf.set(entityId, side);
    this.targetOf.set(entityId, targetId);
    if (targetId !== null) this.bump(side, targetId, 1);
  }

  count(side: string, targetId: string): number {
    return this.counts.get(side)?.get(targetId) ?? 0;
  }

  /** The brain left the world (unregister): drop its claim. */
  remove(entityId: string): void {
    const prev = this.targetOf.get(entityId);
    const side = this.sideOf.get(entityId);
    if (prev != null && side !== undefined) this.bump(side, prev, -1);
    this.targetOf.delete(entityId);
    this.sideOf.delete(entityId);
  }

  /** `targetId` left the world: drop its count entries (claims on it lapse
   *  at the holders' next tick, when they pick again). */
  forgetTarget(targetId: string): void {
    for (const m of this.counts.values()) m.delete(targetId);
  }

  clear(): void {
    this.counts.clear();
    this.targetOf.clear();
    this.sideOf.clear();
  }

  private bump(side: string, targetId: string, d: number): void {
    let m = this.counts.get(side);
    if (m === undefined) {
      m = new Map<string, number>();
      this.counts.set(side, m);
    }
    const n = (m.get(targetId) ?? 0) + d;
    m.set(targetId, n < 0 ? 0 : n);
  }
}
