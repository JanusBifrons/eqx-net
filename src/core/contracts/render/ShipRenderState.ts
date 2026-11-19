export interface ShipRenderState {
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  /** Ship-kind id (`'scout' | 'fighter' | 'heavy' | …`) hydrated from the
   *  Colyseus `ShipState.kind` field. The renderer reads this once when the
   *  Pixi sprite is built and uses the corresponding `ShipKind.shape` to
   *  draw the polygon silhouette + colour. Optional for back-compat with
   *  callers / tests that pre-date the ship-kind feature; the renderer falls
   *  back to the catalogue default when missing. */
  kind?: string;
  /** Player display name (or email fallback). Empty string for anonymous
   *  players; absent for sources that don't carry it. The renderer's
   *  `LabelManager` uses this to render a small text label above remote
   *  ships. The local player's own ship intentionally has no label. */
  displayName?: string;
  /** Per-mount current rotation angle, ship-relative AND already biased
   *  past `mount.baseAngle` (so 0 = barrel at rest, +π/6 = barrel slewed
   *  to +π/6 above its base angle). Indexed by mount-order in the
   *  ship-kind catalogue. Multi-mount/turret refactor (Phase 4b.2):
   *  client-side rotation preview populates this for the local player
   *  only; remote players leave it undefined and the renderer falls
   *  back to baseAngle (static barrels). Phase 4b.3 will populate it
   *  for every ship from server-authoritative snapshot data. */
  mountAngles?: number[];
  /** Effects subsystem (plan `wiggly-puppy` M2): true ⇒ shield down (hull
   *  exposed). Populated by `ColyseusClient.handleSnapshot` from the wire's
   *  per-state `shieldDown` flag (or derived from `shieldPct <= 0`). Mirrors
   *  the existing `swarm[].shieldDown` field — collapses player + drone
   *  shield aura state to "one optional bool per render entry", one
   *  ownership site per renderer-visible state. */
  shieldDown?: boolean;
  /** Phase 4 (Leveling & XP, WS-0) — PUBLIC ship level (≥ 1). Read path for the
   *  small level badge rendered on the ship (visible to all). Mirrored from the
   *  wire's `states[].level` (the broadcaster + badge renderer are owned by
   *  WS-B1). Absent ⇒ level 1. Discrete scalar — purity-clean (Invariant #2). */
  level?: number;
  /** Phase 4 warp-to — 1 spooling, 2 on the run; absent = idle. The local ship
   *  takes its PREDICTED phase each frame, others the snapshot's `warp`
   *  (3 = just dropped out). The renderer draws the build-up, the blur and the
   *  trails from it. */
  warp?: 1 | 2 | 3;
  /** Phase 4 (Dynamic weapon mounts, WS-B3) — PUBLIC activated latent mounts
   *  (`{ slotId, weaponId }[]`). Mirrored from the wire's `states[].mounts` so
   *  the renderer draws the EXTRA turrets on every ship that has activated one.
   *  The per-instance mount list the renderer iterates is
   *  `[...kind.mounts, ...activated]` (geometry looked up by `(kind, slotId)`
   *  from the catalogue — never on the wire). Absent ⇒ no activated mounts.
   *  Non-spatial discrete data — purity-clean (Invariant #2). */
  activatedMounts?: Array<{ slotId: string; weaponId: string }>;
  /** RTS Part A S0 — the wire's `isActive` (a session/pilot is driving the
   *  hull), mirrored as-is. `false` on a parked (lingering) hull and on the
   *  local welcome ship during the pending-join handshake; absent ⇒ not yet
   *  written (treated as active). Read only through the named predicates in
   *  `src/client/render/shipOwnership.ts` (#17), never ad hoc. */
  isActive?: boolean;
  /** The playerId that owns this hull. Active entries in `mirror.ships` are
   *  keyed by it; parked (AI-flown) hulls, keyed by shipInstanceId in the same
   *  map since RTS Part A S3, always carry it. Read through `shipOwner` / `isOwnedByMe`. */
  ownerPlayerId?: string;
  /** The wire's shipInstanceId of the hull this entry draws (the snapshot /
   *  schema key). A parked hull is keyed by it; an active ship (keyed by its
   *  pilot's playerId) carries it so a re-key (taking or letting go of the
   *  controls) finds the entry it moves (`net/shipRekey.ts`). */
  shipInstanceId?: string;
  /** RTS Part A step 8: the room-state `ShipState.health` / `maxHealth`,
   *  copied by `syncMirror` for every ship (pilot- or AI-flown). The fleet
   *  panel's hull % reads these (`net/shipSchemaHealth.ts`). Absent until the
   *  schema brings them. Discrete scalars, never spatial (#2). */
  health?: number;
  maxHealth?: number;
}
