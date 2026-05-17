import type { IAiBehaviour, AiEntity, AiPlayerView, AiWorldView } from '../contracts/IAiBehaviour.js';

/**
 * Per-tick fire request emitted by a behaviour. The controller buffers these
 * and exposes them via `drainFireRequests()` so `SectorRoom.update()` can
 * route them through the existing `handleFire()` lag-comp path. This keeps
 * AI authority single-sourced — drones don't get their own projectile path,
 * they use the same one player shots flow through, with an `ai-${id}` shot id.
 */
export interface AiFireRequest {
  shooterId: string;
  dirX: number;
  dirY: number;
  /** Server tick at which the AI declared the shot. */
  tick: number;
}

export interface AiIntentSink {
  /** Posts an AI_INTENT command to the physics worker for the given slot.
   *  `setAngvel`, when provided, snap-sets the body's angular velocity
   *  (matches the player's input path) — overriding the torque-based
   *  control. The sink is responsible for routing this through whatever
   *  physics layer it owns (server: worker postMessage; client:
   *  `predWorld.setShipAngvel`). */
  postIntent(slot: number, fx: number, fy: number, torque: number, setAngvel?: number): void;
}

interface AiRegistration {
  slot: number;
  behaviour: IAiBehaviour;
}

/**
 * Owns the registered swarm AI entities, ticks them all once per server tick,
 * routes their impulse intents to the physics worker, and surfaces fire
 * requests for the room to drain. Pure server-side glue — no Rapier handles
 * here, no networking. The behaviours themselves stay zone-blind in `src/core`.
 *
 * Thread model: this runs on the main thread alongside `SectorRoom.update()`.
 * Reasoning is recorded in the Phase 5 plan ("AI runs on the main thread") and
 * the deviation is documented in [src/server/CLAUDE.md].
 */
export class AiController {
  private readonly entities = new Map<string, AiRegistration>();
  private readonly fireQueue: AiFireRequest[] = [];

  constructor(private readonly sink: AiIntentSink) {}

  register(entityId: string, slot: number, behaviour: IAiBehaviour): void {
    this.entities.set(entityId, { slot, behaviour });
  }

  unregister(entityId: string): void {
    this.entities.delete(entityId);
  }

  has(entityId: string): boolean {
    return this.entities.has(entityId);
  }

  size(): number {
    return this.entities.size;
  }

  /** Phase 4c (2026-05-11) — read access to the registered behaviour for
   *  a given entity. Used by the server's per-tick drone turret AI so it
   *  can query the drone's hostility set via the shared
   *  `HostileDroneBehaviour` instance, keeping the body AI's "who is
   *  hostile" view and the turret AI's "who do I aim at" view in lockstep
   *  on the same per-instance state. Returns `null` for unregistered ids. */
  getBehaviour(entityId: string): IAiBehaviour | null {
    return this.entities.get(entityId)?.behaviour ?? null;
  }

  /**
   * Forward a hostility-marking event to the registered behaviour, if it
   * exposes the optional `markHostile` hook. Server calls this from
   * `applyDamage` when a drone is hit; the client mirrors it from its
   * `damage` event handler. Both sides receive identical events, so the
   * per-instance hostility state stays in lockstep without a wire-format
   * bump (same shape as the existing `lastFireTick` divergence window).
   */
  markHostile(entityId: string, shooterId: string, atTick: number): void {
    if (!shooterId) return;
    const reg = this.entities.get(entityId);
    reg?.behaviour.markHostile?.(shooterId, atTick);
  }

  /**
   * Purge `playerId` from every registered behaviour's hostility set.
   * Called when a player leaves the sector (transit out, disconnect) — the
   * threat is gone from this sector's perspective. O(N) over registered
   * drones; cheap at the few-dozen scale we run.
   */
  purgeHostility(playerId: string): void {
    if (!playerId) return;
    for (const reg of this.entities.values()) {
      reg.behaviour.purgeHostility?.(playerId);
    }
  }

  /**
   * Render-side query: is the given entity's behaviour currently treating
   * `playerId` as a hostile target? Returns false if the entity isn't
   * registered or its behaviour doesn't implement the optional query (e.g.
   * asteroid drift behaviour, which has no notion of hostility). Pure /
   * side-effect-free; safe to call every frame.
   */
  isEntityHostileToPlayer(entityId: string, playerId: string): boolean {
    if (!playerId) return false;
    const reg = this.entities.get(entityId);
    return reg?.behaviour.isHostileToPlayer?.(playerId) ?? false;
  }

  /**
   * Tick EVERY registered AI once (the per-frame live loop). `entitySnapshot(id)`
   * must return the live pose (read from SAB by the caller earlier in the tick);
   * behaviours never touch the worker themselves. `players` is the up-to-date
   * list of alive player poses for nearest-target queries.
   *
   * Intents are posted to the worker immediately; fire requests buffer for the
   * caller to drain via `drainFireRequests()` after physics steps. Iteration
   * order over `this.entities` is registration order — the tie-break
   * determinism the WeaponMountController contract depends on. Unchanged since
   * before Option A: the live loop is byte-identical to pre-2026-05-17.
   */
  tick(
    tick: number,
    dtSec: number,
    players: ReadonlyArray<AiPlayerView>,
    entitySnapshot: (id: string) => AiEntity | null,
  ): void {
    if (this.entities.size === 0) return;
    const view: AiWorldView = { players, tick, dtSec };
    for (const [id, reg] of this.entities) {
      this.runEntity(id, reg, view, tick, entitySnapshot);
    }
  }

  /**
   * Tick ONLY the supplied entity ids — the relevance-culled reconciler-replay
   * re-sim (Option A, 2026-05-17, diag a3f5na). This iterates `ids` (O(k)), NOT
   * the full registry, so it does NOT reintroduce the O(ticksAhead × N) Map
   * scan that a predicate-over-`tick` would: replay re-sim is genuinely
   * O(k × ticksAhead), k ≪ N, while the stable FAR majority holds frozen at
   * its server-authoritative replay anchor (no inertia drift → its re-sim
   * would be dead work). Per-entity semantics are identical to {@link tick}
   * (shared `runEntity`). Unknown / unregistered ids are skipped. Cross-entity
   * order is irrelevant to determinism — each behaviour's intent is an
   * independent function of its own pose + the shared player view; drones
   * never observe each other.
   */
  tickOnly(
    ids: Iterable<string>,
    tick: number,
    dtSec: number,
    players: ReadonlyArray<AiPlayerView>,
    entitySnapshot: (id: string) => AiEntity | null,
  ): void {
    if (this.entities.size === 0) return;
    const view: AiWorldView = { players, tick, dtSec };
    for (const id of ids) {
      const reg = this.entities.get(id);
      if (reg) this.runEntity(id, reg, view, tick, entitySnapshot);
    }
  }

  /** Snapshot → behaviour.tick → post intent / queue fire for one entity.
   *  Shared by {@link tick} (all) and {@link tickOnly} (relevance-culled
   *  replay) so the two paths can never diverge in per-entity semantics. */
  private runEntity(
    id: string,
    reg: AiRegistration,
    view: AiWorldView,
    tick: number,
    entitySnapshot: (id: string) => AiEntity | null,
  ): void {
    const self = entitySnapshot(id);
    if (!self) return;
    const intent = reg.behaviour.tick(self, view);

    if (
      intent.fx !== 0 ||
      intent.fy !== 0 ||
      intent.torque !== 0 ||
      intent.setAngvel !== undefined
    ) {
      this.sink.postIntent(reg.slot, intent.fx, intent.fy, intent.torque, intent.setAngvel);
    }

    if (intent.fire) {
      this.fireQueue.push({
        shooterId: id,
        dirX: intent.fire.dirX,
        dirY: intent.fire.dirY,
        tick,
      });
    }
  }

  /**
   * Returns and clears the fire requests accumulated this tick. Caller should
   * route each through the same `handleFire()` path used by player shots.
   * Returns the live array to avoid allocations; caller must not retain it.
   */
  drainFireRequests(): AiFireRequest[] {
    if (this.fireQueue.length === 0) return EMPTY;
    const out = this.fireQueue.slice();
    this.fireQueue.length = 0;
    return out;
  }
}

const EMPTY: AiFireRequest[] = [];
