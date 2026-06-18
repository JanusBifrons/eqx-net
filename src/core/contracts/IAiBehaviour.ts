/**
 * AI behaviour contract — pure logic, zero zone awareness.
 *
 * `tick()` is called once per server tick per swarm entity. It receives a
 * read-only world view (player positions injected by the server) and returns
 * an intent: an impulse / torque to apply this step, plus an optional fire
 * request that the server resolves through the existing weapon path.
 *
 * Behaviours never construct Rapier objects, never read globals, and never
 * import server or client code — they are deterministic functions of their
 * arguments. Authority over physics and projectiles stays with the server.
 */

export interface AiPlayerView {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  /** Current hull health + its max, for health-weighted target selection
   *  (drones focus the wounded). Optional — when absent the picker falls back
   *  to pure nearest. Server-populated; the client never builds drone views
   *  (drones are snapshot-interpolated, no client brain). */
  readonly health?: number;
  readonly maxHealth?: number;
}

/**
 * A static structure the AI may treat as a target (wave-system Phase 2). Same
 * shape family as `AiPlayerView` minus velocity (structures don't move), plus a
 * `priority` so the picker can favour a Capital over a Solar without the brain
 * hard-coding structure kinds (Open/Closed). Server-populated only.
 */
export interface AiStructureView {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** Hull health + max for health-weighted selection (optional, like players). */
  readonly health?: number;
  readonly maxHealth?: number;
  /** Class-priority weight (higher = attack first). Fed to
   *  `WeaponMountController.pickTarget` via `priorityBias`. */
  readonly priority: number;
}

/**
 * Read-only snapshot the AI controller hands to each behaviour. Behaviours
 * may not retain references past the call — the server may reuse the array.
 */
export interface AiWorldView {
  /** Live, alive players. Empty when none are present. */
  readonly players: ReadonlyArray<AiPlayerView>;
  /**
   * Hostile structures this drone may target (wave-system Phase 2). Empty/absent
   * for ambient drones and for any sector with no faction "under wave". The
   * server builds this list ONCE per tick (faction-filtered) and reuses it;
   * behaviours read it in their COMBAT branch.
   *
   * **SERVER-ONLY — no wire bump.** Unlike the chapter-2 Input Symmetry Rule,
   * the client runs NO drone brain (drones are pure snapshot-interpolated; the
   * client `HostileDroneBehaviour` is a hostility ledger that is never
   * `tick()`'d — see `src/core/CLAUDE.md` "AI lockstep — SUPERSEDED FOR
   * DRONES"). So a behaviour-visible field consumed only inside `tick()` needs
   * no `SWARM_WIRE_VERSION` bump and creates no lockstep surface. Drone targeting
   * of structures is resolved entirely server-side.
   */
  readonly structures?: ReadonlyArray<AiStructureView>;
  /** Current server tick. Behaviours use this for cooldowns. */
  readonly tick: number;
  readonly dtSec: number;
  /**
   * Resolve ANOTHER swarm entity's LIVE pose into a caller-owned buffer
   * (returns false if it's gone). The leader-led flocking behaviour uses this
   * to read its leader's + squad-neighbours' current poses every tick — the
   * thing the fixed-wedge-slot scheme couldn't do (it only had a 1.5 s stale
   * point). **SERVER-ONLY, no wire surface** (same rationale as `structures`
   * above — the client runs no drone brain). MUST write into the passed `out`,
   * never a shared scratch the caller's `self` aliases. Absent ⇒ no flocking
   * data (the behaviour falls back to patrol). */
  resolveEntityInto?(id: string, out: AiEntityPoseOut): boolean;
}

/** Mutable pose buffer for `AiWorldView.resolveEntityInto` (caller-owned, so
 *  resolving a neighbour never clobbers the brain's own `self`). */
export interface AiEntityPoseOut {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angvel: number;
}

/** The AI's own pose for this tick. */
export interface AiEntity {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  readonly angvel: number;
}

/**
 * The intent a behaviour produces each tick. Linear impulse is applied to
 * the rigid body in the worker. Angular control is one of:
 *  - `torque` — applied via `applyTorqueImpulse` (legacy P-controller path,
 *    fights `1.5 × angvel` damping).
 *  - `setAngvel` — applied via `body.setAngvel(value, true)` (matches the
 *    player input path, snap-set with no damping fight). Behaviours that
 *    want player-equivalent agility set this and leave `torque = 0`.
 *
 * If both are set, the worker applies `setAngvel` first then adds the
 * torque impulse on top — but in practice you should pick one.
 *
 * `fire`, when present, asks the server to fire a hitscan in `(dirX, dirY)`
 * direction on this entity's behalf. The server resolves it through the
 * existing `handleFire` lag-comp path with an `ai-` prefixed shot id.
 */
export interface AiIntent {
  fx: number;
  fy: number;
  torque: number;
  /** Optional snap-set angular velocity (rad/s). When present, the worker
   *  calls `body.setAngvel(setAngvel, true)` instead of/before adding any
   *  torque impulse. Mirrors the player's `setAngvel(target * maxAngvel)`
   *  input path so a drone can match a player's turn rate without fighting
   *  damping. */
  setAngvel?: number;
  fire?: { dirX: number; dirY: number };
}

export interface IAiBehaviour {
  tick(self: AiEntity, view: AiWorldView): AiIntent;
  /**
   * Optional event-driven mutation hooks. Both must be event-symmetric:
   * the same call is made on the server (from `applyDamage`/`onLeave`)
   * and on the client (from the `damage` event handler / ship-departure
   * sweep) so per-instance state stays in lockstep without a wire-format
   * bump. Same pattern as the existing `lastFireTick` field.
   */
  markHostile?(shooterId: string, atTick: number): void;
  purgeHostility?(playerId: string): void;
  /**
   * Optional read-only query: is the behaviour currently hostile to the
   * given player? Used by render-side surfaces (e.g. the halo radar) that
   * want to colour entities differently based on their threat state.
   * Pure / side-effect-free; safe to call every frame.
   */
  isHostileToPlayer?(playerId: string): boolean;
  /**
   * Optional in-sector MOVE target (roaming-formation system, Phase 5).
   * SERVER-ONLY: the `LivingWorldDirector` assigns each squad member a
   * formation-slot world point each control tick; while IDLE (neutral/roaming)
   * the drone flies to it via an arrive behaviour (slows to a stop), instead of
   * the default origin orbit. The client never ticks the drone brain, so this
   * creates no lockstep surface and needs no wire bump. `clearMoveTarget`
   * reverts to the orbit.
   */
  setMoveTarget?(x: number, y: number): void;
  clearMoveTarget?(): void;
  /**
   * Leader-led flocking (non-combat herding). The `LivingWorldDirector` marks
   * one squad member the LEADER (given a course via `setMoveTarget`) and calls
   * this on every OTHER member with the leader's id + the squad's member ids.
   * While IDLE the follower flocks (cohesion/alignment/separation) to the
   * leader's LIVE pose (resolved each tick via `AiWorldView.resolveEntityInto`)
   * instead of chasing a stale wedge slot. SERVER-ONLY (no client brain ⇒ no
   * lockstep surface / wire bump). `setMoveTarget` clears the follower role
   * (you're a leader/independent mover); `clearMoveTarget` reverts to orbit. */
  setFlockFollow?(leaderId: string, memberIds: readonly string[]): void;
}

/** Returns the nearest player to (x, y), or null when no players are present. */
export function nearestPlayer(view: AiWorldView, x: number, y: number): AiPlayerView | null {
  let best: AiPlayerView | null = null;
  let bestD2 = Infinity;
  for (const p of view.players) {
    const dx = p.x - x;
    const dy = p.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = p;
    }
  }
  return best;
}
