/**
 * IDamageable — the interaction-resolution surface for the Generic Entity
 * Pipeline. Collapses DamageRouter's 4-branch id-shape if-tree into a uniform
 * orchestration driven by per-KIND strategy singletons, so adding a new
 * damageable type is a registry entry, not a new dispatch branch (the P4
 * "structure for free" proof).
 *
 * This core file owns the ZONE-PURE, reusable damage-application surface:
 *   - HealthBinding — a STATELESS, per-kind strategy that applies layered
 *     shield→hull damage to the live store behind a `target`. One instance per
 *     kind, created once (never per hit → zero hot-loop allocation, #14).
 *   - Interaction / InteractionResultMut — the reused input/output value
 *     objects (the orchestrator owns one of each and passes them in).
 *
 * The kind-specific ORCHESTRATION (what to broadcast on a hit, what to tear
 * down on death) is a SERVER concern — it touches Colyseus broadcast / bus /
 * worker seams and wire-id construction — so the `PerHitEffect` / `DeathPolicy`
 * strategies + the `EntityResolver` that selects them live in src/server
 * (`DamageRouter.ts`), not here. Core stays blind to the wire.
 *
 * The call site stays effectively monomorphic (HC#5): there is no per-kind
 * `Entity.receiveInteraction` virtual dispatch across N hidden classes — the
 * server orchestrator is one method reading a 3-field strategy looked up by
 * resolved kind. `target` is typed `unknown` here so the contract stays
 * zone-pure; concrete server bindings narrow it to the real store type.
 */

/** A discrete interaction delivered to an entity. Phase 1 = damage only; the
 *  discriminant leaves room for `'heal'` / `'force'` (black-hole pull) later. */
export interface Interaction {
  readonly kind: 'damage';
  readonly amount: number;
  /** Aggressor id (shooterId). Empty string when sourceless. */
  readonly sourceId: string;
  readonly hitX?: number;
  readonly hitY?: number;
  /** Authoritative server tick the interaction resolves at. */
  readonly atTick: number;
}

/**
 * Mutable, REUSED result — the orchestrator owns one instance and passes it in
 * to be filled, so the hot path never allocates. Mirrors the fields the
 * `DamageEvent` broadcast needs so the event is built from it with no shape
 * change.
 */
export interface InteractionResultMut {
  /** false = immune / dead / not-yet-active (no event emitted). */
  applied: boolean;
  newHealth: number;
  newShield: number;
  shieldMax: number;
  hullMax: number;
  hitLayer: 'shield' | 'hull';
  /** Crossed to <= 0 hull on THIS interaction (drives the DeathPolicy). */
  destroyed: boolean;
}

/** Reset a reused result to the neutral no-op state. Returns it. */
export function resetInteractionResult(out: InteractionResultMut): InteractionResultMut {
  out.applied = false;
  out.newHealth = 0;
  out.newShield = 0;
  out.shieldMax = 0;
  out.hullMax = 0;
  out.hitLayer = 'hull';
  out.destroyed = false;
  return out;
}

/**
 * HealthBinding — applies layered shield→hull damage to the live store behind
 * `target`, filling `out`. NEVER a value copy: it reads/applies against the
 * real store (HC#3 — a drone's hull lives in the parallel `swarmHealth` map,
 * not on its record). Stateless + per-kind: the SAME instance handles every
 * entity of its kind; the entity-specific state is the `target` argument.
 * Set `out.applied=false` for an immune/absent target (asteroid).
 */
export interface HealthBinding {
  applyLayered(target: unknown, amount: number, atTick: number, out: InteractionResultMut): void;
}
