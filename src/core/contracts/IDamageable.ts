/**
 * IDamageable — the single interaction sink for the Generic Entity Pipeline.
 *
 * Today damage is dispatched by a 4-branch if-tree in
 * `src/server/rooms/DamageRouter.ts`, keyed on the SHAPE of a target-id
 * string (wreck- prefix / lingering `!isActive` / active playerId / swarm
 * registry). Each branch hard-codes its own health store + death
 * side-effects. This contract is the collapse target: an entity receives an
 * interaction and resolves it through composed DATA, so the call site is
 * MONOMORPHIC (one concrete class), not a virtual dispatch across N leaf
 * classes (HC#5 — that would megamorphic-deopt under ramming/projectile
 * load).
 *
 * Phase 1 adds the surface ONLY: adapters implement `HealthBinding` over the
 * existing stores and are unit-tested for parity with the current layered-
 * damage primitives. Phase 2 routes `DamageRouter` through `DamageableEntity`
 * and moves each branch's broadcast/destroy/bus/worker side-effects verbatim
 * into a `DeathPolicy`.
 *
 * PHASE 2 DESIGN NOTES (from the Phase-1 adversarial review — close before the
 * dispatch collapse):
 *  - Every current DamageRouter branch broadcasts a `DamageEvent` on EVERY hit
 *    (not just death) and the swarm branch also `markHostile`s + emits a
 *    `damage_applied` diag on non-fatal hits. `receiveInteraction` fills `out`
 *    (newHealth/newShield/shieldMax/hullMax/hitLayer) + `destroyed`; the
 *    Phase-2 RESOLVER (the DamageRouter replacement) builds + broadcasts the
 *    `DamageEvent` from `out` plus the `Interaction.hitX/hitY/sourceId` it
 *    already holds. Keep the per-hit broadcast in the resolver (one place);
 *    only the DEATH-specific teardown belongs in `DeathPolicy`. Swarm-only
 *    per-hit effects (markHostile + diag) ride an optional per-hit hook or stay
 *    a thin resolver branch — decide in Phase 2 without reintroducing the
 *    4-way id-shape if-tree.
 *  - `DeathPolicy.onDestroyed` carries only ids; lingering-death needs the slot
 *    (freeSlots/DESPAWN) and swarm-death needs the full `rec` (evictSwarmEntity)
 *    — those are captured in the per-kind policy CLOSURE, not added to the
 *    signature (keeps the call site uniform).
 *
 * Zone-pure (src/core): the concretions (ShipState mutation, the swarmHealth
 * map, broadcast/bus/worker seams) are injected by the server.
 */

/** A discrete interaction delivered to an entity. Phase 1 = damage only;
 *  the discriminant leaves room for `'heal'` / `'force'` (black-hole pull)
 *  later without widening the call site. */
export interface Interaction {
  readonly kind: 'damage';
  readonly amount: number;
  /** Aggressor id (shooterId). Empty string when sourceless. */
  readonly sourceId: string;
  /** World hit position, when the caller has it (else the entity's pose is used). */
  readonly hitX?: number;
  readonly hitY?: number;
  /** Authoritative server tick the interaction resolves at. */
  readonly atTick: number;
}

/**
 * Mutable, REUSED result of an interaction — the caller owns one instance and
 * passes it in to be filled, so the hot damage path never allocates
 * (invariant #14). Mirrors the fields the current `DamageEvent` broadcast
 * needs so Phase 2 can build the event from it with zero shape change.
 */
export interface InteractionResultMut {
  /** false = immune / dead / not-yet-active (no event should be emitted). */
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
 * HealthBinding — an INJECTED ACCESSOR bound to wherever an entity's layered
 * HP actually lives. NEVER a value copy: it reads/applies against the live
 * store, so there is no second source of truth to desync. This is the
 * concrete answer to HC#3: a drone's hull lives in the parallel
 * `CombatSubsystem.swarmHealth` map (not on the swarm record), so the drone
 * adapter's binding holds a reference to that map; the ship binding mutates
 * `ShipState` fields; the wreck binding mutates the wreck record.
 */
export interface HealthBinding {
  /**
   * Apply `amount` layered shield→hull damage to the REAL store at `atTick`
   * and fill `out`. Set `out.applied=false` for an immune/absent target
   * (asteroid) and leave the other fields untouched. Allocation-free.
   */
  applyLayered(amount: number, atTick: number, out: InteractionResultMut): void;
}

/**
 * DeathPolicy — what happens when an entity crosses to 0 hull. Phase 1
 * defines the shape; Phase 2 fills each implementation with the EXACT
 * side-effects currently inlined in the matching DamageRouter branch
 * (broadcast destroy, bus SHIP_DESTROYED, free the lingering slot + DESPAWN
 * `linger-<id>`, destroyWreck, evictSwarmEntity, …). Keeping them behind this
 * interface is what lets the dispatch tail collapse without changing
 * behaviour (HC#1 — the branch side-effects are load-bearing and asymmetric).
 */
export interface DeathPolicy {
  onDestroyed(entityId: string, sourceId: string, atTick: number): void;
}

/** The interaction sink. Implemented once, concretely, by `DamageableEntity`. */
export interface IDamageable {
  receiveInteraction(it: Interaction, out: InteractionResultMut): void;
}

/**
 * The ONE concrete implementation of `IDamageable`. Every damage call site
 * invokes `DamageableEntity.prototype.receiveInteraction`, so the site stays
 * monomorphic regardless of how many leaf kinds exist — the per-kind
 * variation is the injected `health` + `death` DATA, not a subclass override
 * (HC#5). Do NOT replace this with per-kind `Entity.receiveInteraction`
 * overrides: that reintroduces the megamorphic virtual dispatch this design
 * exists to avoid.
 */
export class DamageableEntity implements IDamageable {
  constructor(
    readonly entityId: string,
    private readonly health: HealthBinding,
    private readonly death: DeathPolicy,
  ) {}

  receiveInteraction(it: Interaction, out: InteractionResultMut): void {
    this.health.applyLayered(it.amount, it.atTick, out);
    if (out.applied && out.destroyed) {
      this.death.onDestroyed(this.entityId, it.sourceId, it.atTick);
    }
  }
}
