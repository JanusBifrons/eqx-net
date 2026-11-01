/**
 * Hostile-act ledger (plan soft-leaping-truffle v3, phase B1). Remembers who
 * committed a hostile act (a break-in, an attack on a base) against which
 * owner, until a cooldown expires. `relationOf` reads it through
 * `HostileActQuery`, so a hostile act makes the actor 'hostile' to that owner
 * everywhere at once: turrets, gates, cargo.
 *
 * Indexed owner → actor → expiry, so the hot-path query builds no key strings
 * and allocates nothing (invariant #14). Recording happens on discrete events.
 */
import { HOSTILE_ACT_COOLDOWN_MS, type HostileActQuery } from '../../shared-types/relations.js';

export class HostileActLedger implements HostileActQuery {
  private readonly byOwner = new Map<string, Map<string, number>>();

  /** Mark `actor` hostile to `owner` until `nowMs + cooldownMs` (extends, never shortens). */
  record(actor: string, owner: string, nowMs: number, cooldownMs: number = HOSTILE_ACT_COOLDOWN_MS): void {
    if (actor === owner) return;
    let actors = this.byOwner.get(owner);
    if (!actors) {
      actors = new Map();
      this.byOwner.set(owner, actors);
    }
    const until = nowMs + cooldownMs;
    if ((actors.get(actor) ?? 0) < until) actors.set(actor, until);
  }

  isHostile(actor: string, owner: string, nowMs: number): boolean {
    const until = this.byOwner.get(owner)?.get(actor);
    return until !== undefined && until > nowMs;
  }

  /** Forget an actor's acts against an owner (e.g. a gift or a settlement later). */
  clear(actor: string, owner: string): void {
    const actors = this.byOwner.get(owner);
    if (!actors) return;
    actors.delete(actor);
    if (actors.size === 0) this.byOwner.delete(owner);
  }

  /** Drop expired entries. Call on a slow cadence, not per tick. */
  sweep(nowMs: number): void {
    for (const [owner, actors] of this.byOwner) {
      for (const [actor, until] of actors) if (until <= nowMs) actors.delete(actor);
      if (actors.size === 0) this.byOwner.delete(owner);
    }
  }

  /** Number of live entries (for tests and diagnostics). */
  size(): number {
    let n = 0;
    for (const actors of this.byOwner.values()) n += actors.size;
    return n;
  }
}
