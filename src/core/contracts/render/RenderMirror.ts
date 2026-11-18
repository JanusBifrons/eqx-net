import type { PackedChunk } from '../../terrain/packedChunk.js';
import type { WreckDescriptor } from '../../../shared-types/messages/snapshotMessages.js';
import type { ShipRenderState } from './ShipRenderState.js';
import type { SwarmRenderState } from './SwarmRenderState.js';
import type { MineRenderState, StructureRenderState } from './StructureRenderState.js';
import type { MissileRenderState, ProjectileRenderState, ShellSalvoRenderInfo } from './ProjectileRenderState.js';

export interface RenderMirror {
  /** The sector's game speed (time scale stream), from the snapshot keyframe.
   *  Absent = 1×. Renderers read it for the display-delay window and the
   *  presentation frame dt, so every effect follows the speed on its own. */
  timeScale?: number;
  /** Phase 4 travel state: a sector-to-sector trip is under way (the backdrop
   *  fades to deep space; the local ship flies on). Absent = no trip. */
  travelling?: boolean;
  /** Phase 4 travel state: in the empty middle of a trip (the sky thins to deep
   *  space); false while flying out of the old sector and into the new one. */
  travelDeep?: boolean;
  /** The local ship's sector-transit spool length (ms) while it spools, so
   *  the spool-up builds over the whole spool (a 3 s in-system warp spool
   *  is the default when absent). */
  localSpoolMs?: number;
  /** Phase 4 travel state: the total jump (game space) made by placing the
   *  ship on its approach; the renderer shifts the sky by it so the stars
   *  carry on unbroken. */
  travelJumpX?: number;
  travelJumpY?: number;
  /** Phase 4 travel state: the sector a transit is heading for, set during the
   *  spool so the renderer prepares its sky early. Absent = none. */
  prewarmSector?: string;
  /** The frame timestamp the local ship's pose is drawn at (main-thread
   *  performance.now base; deltas only). The cinematic camera's velocity
   *  estimate uses it. Absent ⇒ the renderer's clock. */
  frameTimeMs?: number;
  /** EVERY ship (RTS Part A S3, one ship list): active ships keyed by their
   *  pilot's playerId (local prediction is playerId-keyed), parked / AI-flown
   *  hulls (wire `isActive=false`) keyed by shipInstanceId. Which key a wire
   *  ship gets is `client/net/shipMirrorKey.ts`; loops that treat the two
   *  differently gate on the named predicates in
   *  `client/render/shipOwnership.ts` (`isParkedHull`, #17). */
  ships: Map<string, ShipRenderState>;
  /**
   * Swarm entities (asteroids + drones) shipped via the binary swarm channel.
   * Keyed by the server's dense u16 entityId. Sleeping entries remain in the
   * map at their last-shipped pose and the renderer freezes interpolation.
   */
  swarm?: Map<number, SwarmRenderState>;
  /** Structures plan, Phase 3 — slow-moving grid state for placed structures,
   *  keyed by the SAME dense entityId as `swarm` (the structure's POSE lives in
   *  `swarm`; this carries the grid web + power/construction state). Mirrored
   *  from `SnapshotMessage.structures[]`. The renderer joins by entityId to draw
   *  the connector web + scaffolding fill + dim unbuilt blueprints. */
  structures?: Map<number, StructureRenderState>;
  /** Capital destruction S2b — each live wreck's fracture inputs, keyed by
   *  wreckId, mirrored from the `wrecks[]` snapshot descriptor. Small plain
   *  records: the renderer rebuilds each piece's shape from them with the
   *  shared deterministic `wreckPieceGeometry` (no vertex crosses the worker
   *  boundary). */
  wrecks?: Map<number, WreckDescriptor>;
  /** The room breaks dying capitals into wrecks (welcome `capitalWrecks`):
   *  a dying capital then gets the break-up explosion at its kill point, not
   *  the hull-sized death blast. */
  capitalWrecks?: boolean;
  /** The room breaks dying sub-capitals into wrecks (welcome `subcapWrecks`,
   *  sub-capital break-up): the dying hull is held briefly until its pieces
   *  are drawn. Its normal death explosion still plays. */
  subcapWrecks?: boolean;
  /** Set while a ship killed by an event shell is still drawn alive, waiting
   *  for the drawn shell to reach it (shell-events.md "Kills wait for the
   *  drawn shell"): wreck pieces of a wreck that died on or after this server
   *  tick get no sprite yet, so its wreck does not show beside the live hull.
   *  Pieces already drawn are unaffected. Absent = no hold. */
  wreckRevealFromTick?: number;
  /** Mine Layer — proximity mines, keyed by mine id (room state `mines`). */
  mines?: Map<string, MineRenderState>;
  /** Ship tractor beams (emitter → target: a swarm entityId or a playerId), from the snapshot's beam links (client/net/tractorLinks.ts). */ tractorLinks?: Array<{ emitter: number | string; mountId: string; target: number | string }>;
  /** Structures plan, Phase 3 — connection flash windows from the discrete
   *  `grid_pulse` event. Key is the sorted entityId pair packed as
   *  `min * 65536 + max` (numeric ⇒ no per-frame string-key allocation in the
   *  renderer); value is the `performance.now()` ms until which the segment
   *  renders "flowing". */
  gridFlashes?: Map<number, number>;
  /** R2.2 — per-edge flow DIRECTION for the travelling-pulse comet. Same packed
   *  `min * 65536 + max` key as `gridFlashes`; value is the entityId that was
   *  the route SOURCE for the latest pulse (the `grid_pulse.flashed` pairs are
   *  ordered source→dest, but the sorted key discards that — this recovers it).
   *  Absent ⇒ the comet defaults to running lower-id → higher-id. Plain numbers,
   *  so it crosses the worker boundary like `gridFlashes`. */
  gridFlowSrc?: Map<number, number>;
  /** WS-D (#12) — per-edge flow MATERIAL for the connector tint. Same packed
   *  `min * 65536 + max` key as `gridFlashes`; value is the numeric material code
   *  (`flowMaterialToCode` in `connectorVisual.ts`: 0=minerals, 1=repair,
   *  2=construction, 3=power) so the renderer tints a repair route green, a haul
   *  route orange, a build route cyan — all in the SAME pulse. Numeric (not a
   *  string) ⇒ no per-frame alloc + cheap structured-clone across the worker
   *  boundary. Absent ⇒ the renderer defaults to minerals (back-compat). */
  gridFlowMaterial?: Map<number, number>;
  /** Projectiles: both server-authoritative and client ghost entries. */
  projectiles?: Map<string, ProjectileRenderState>;
  /** Shells as events (docs/architecture/shell-events.md): what the
   *  `shell_salvo` messages said about each naval shell, keyed by the same id
   *  as its `projectiles` entry. Present only when the welcome said
   *  `shellEvents: true`. Pooled records, mutated in place. */
  shellSalvos?: Map<string, ShellSalvoRenderInfo>;
  /** Shells as events (slice 2b): `shell_end` hits awaiting their impact
   *  burst, flat `[x, y, shellRadius]` triples in game space. One-frame
   *  queue: cleared by `consumeOneFrameTriggers` after a render. */
  pendingShellEnds?: number[];
  /** In-flight heat-seeking missiles. Server-authoritative pose mirrored
   *  from `SnapshotMessage.missiles[]` (per-recipient AOI-filtered).
   *  Keyed by the stable per-sector missileId. The renderer draws the
   *  missile sprite + trail + reads `lifePct` for end-of-life fade.
   *  Entries are removed when (a) `missile_detonated` arrives, or (b)
   *  the missile vanishes from a full snapshot (eviction). */
  missiles?: Map<number, MissileRenderState>;
  localPlayerId: string | null;
  /** The local player's ACTIVE ship's shipInstanceId (from the `welcome`
   *  message). A displaced player owns BOTH a lingering hull and a new active
   *  ship under the same `playerId`, so own-ship identification must key on
   *  this — NOT just `localPlayerId` — to avoid binding the local view to the
   *  stale lingering hull. Null until welcome. */
  localShipInstanceId?: string | null;
  /** Floating damage numbers to spawn this frame. Drained + cleared each
   *  frame. `targetId` groups hits to the same entity so the renderer's
   *  accumulator can sum them into one floating number (plan: melodic-
   *  engelbart Step 4 — was N parallel numbers, now 1-per-target
   *  growing). `tag` (weapon-hit-prediction Phase 2) is the originating
   *  `clientShotId` for client-PREDICTED numbers, so a later mispredict /
   *  rollback / TTL-expiry can hard-cancel exactly that number's
   *  contribution via `pendingDamageNumberCancels`. Authoritative (server
   *  `DamageEvent`) numbers leave `tag` undefined. Plain strings ⇒
   *  structured-clone-safe across the renderer→worker boundary. */
  pendingDamageNumbers?: Array<{ targetId: string; x: number; y: number; damage: number; tag?: string }>;
  /** Predicted damage-number tags to hard-cancel this frame (weapon-hit-
   *  prediction Phase 2). The renderer drains it and calls
   *  `DamageNumberManager.cancelByTag(tag)` for each — the rollback /
   *  TTL-expiry channel, mirroring the `pendingDamageNumbers` drain
   *  pattern. Cleared + drained each frame. */
  pendingDamageNumberCancels?: string[];
  /** Health bar hit events this frame. Drained + cleared each frame.
   *  `shieldPct` is optional — when present (and the entity has any
   *  shield max > 0), `HealthBarManager` renders a two-segment bar
   *  with shield ABOVE hull so shield damage is visible. Without
   *  this, drones/bots' shield hits look like "zero damage" because
   *  hull stays at 100% while shield absorbs (no per-entity HUD
   *  ShieldHullBar exists for them — the on-hit bar is the only
   *  shield-damage feedback). */
  pendingHealthBarHits?: Array<{
    entityId: string;
    healthPct: number;
    shieldPct?: number;
    /** HULL fraction BEFORE this hit, for the Street-Fighter chip-damage
     *  band (the lighter "recent damage" trail that drains down after the
     *  attack stops). Client-derived from the DamageEvent (newHealth +
     *  damage, hull hits only) — NOT on the wire. Omitted ⇒ no chip. */
    preHealthPct?: number;
  }>;
  /** Macro terrain v2 (room flag `cutField`): cut-field chunks loaded or
   *  dropped since the last frame. `outlines` is [n, x0, y0, …, n, …] in game
   *  space; null drops the chunk. Drained each frame, like `pendingMissileExplosions`;
   *  only a chunk load or unload adds an entry, never a frame. `ore`: [ice,
   *  crystal] per rock-fan vertex (`oreForOutlines`), for the ore look.
   *  `bodies`: the packed chunk (each rock's body and convex parts), so the
   *  link preview tests an awake rock's real shape (C5c). `moved`: [index, x,
   *  y, angle] per moved rock (C2 deep sleep), drawn there instead.
   *  `level: 'coarse'`: a far-zoom tile (B4; cx, cy are the tile coords),
   *  outlines and ore only, drawn instead of the chunks when zoomed far out. */
  pendingFieldChunks?: Array<{ cx: number; cy: number; outlines: Float32Array | null; ore?: Float32Array | null; bodies?: PackedChunk | null; moved?: Float64Array | null; level?: 'coarse' }>;
  /** Missile detonations to play this frame. The renderer drains the
   *  array, spawns explosion VFX at each `(x, y)`, sizes the sprite to
   *  `splashRadius`, and triggers a camera shake with magnitude inverse
   *  to distance-from-camera (with a min-distance floor to prevent
   *  divide-by-zero / point-blank shake explosion). Cleared each frame. */
  pendingMissileExplosions?: Array<{
    x: number;
    y: number;
    splashRadius: number;
    missileId: number;
  }>;
  /** Effects subsystem (plan `wiggly-puppy` M2): one-shot effect-trigger
   *  drain queue, populated by `ColyseusClient` (impact sparks via
   *  `handleDamage`, destruction via the existing `explodingShips` drain
   *  path) and consumed by `PixiRenderer.update(mirror)` which forwards
   *  each entry to `IEffects.spawnBurst` / `triggerOneShotFilter`.
   *
   *  CLEAR DISCIPLINE (load-bearing): cleared INSIDE `consumeOneFrameTriggers`
   *  in `src/client/render/perFrameTriggers.ts`, gated on `shouldRender` —
   *  same skip-frame gate as `explodingShips`. A clear without a preceding
   *  `renderer.update(...)` silently drops every trigger in the queue.
   *  Regression lock: `perFrameTriggers.test.ts`. */
  pendingEffectTriggers?: Array<{
    kind:
      | 'impact'
      | 'destruction'
      | 'shield-hit'
      | 'warp-arrive'
      | 'destruction-shock'
      | 'shield-flash'
      /** A shield fence stopped a bolt or missile at (worldX, worldY). */
      | 'wall-hit'
      /** A collision touched `entityId`'s shield; (worldX, worldY) is the
       *  other body, which the contact faces. Drawn only on a raised shield. */
      | 'shield-contact';
    worldX: number;
    worldY: number;
    intensity?: number;
    tint?: number;
    entityId?: string;
  }>;
  /**
   * When present, the renderer draws a semi-transparent ghost at this position to
   * show the raw server snapshot position (before client-side prediction replay).
   * Lets you visually confirm whether the server and client are diverging.
   */
  serverGhostPos?: { x: number; y: number } | null;
  /**
   * Structure placement preview (smoke handoff 2026-06-06, Issue 5). When the
   * player is in placement mode the renderer draws a translucent silhouette of
   * the chosen structure kind at the computed ahead-of-ship world pose, and
   * projects that pose to screen for the world-anchored confirm. Spatial data
   * → it lives HERE in the render mirror, NOT Zustand (invariant #2); only the
   * discrete `placementKind` id stays in Zustand. `null`/absent ⇒ no preview.
   * `kind` is a StructureKindId; `x`/`y` are GAME-space (Y-up); `angle` rad.
   * Structured-cloneable (plain object) so it crosses the worker boundary.
   */
  pendingPlacementPreview?: { kind: string; x: number; y: number; angle: number; pending?: boolean } | null;
  /**
   * Helm move marker (owner 2026-11-12): the local pilot's active helm course
   * point, GAME-space, while they fly a capital under a helm order (never for
   * other ships, never while spectating). `seq` bumps on each new course tap
   * so the renderer replays its pop. Spatial ⇒ here, never Zustand (#2).
   * A reused plain object (structured-cloneable); `null`/absent ⇒ no marker.
   */
  helmCourse?: { x: number; y: number; seq: number } | null;
  /** Ships currently flashing due to recent damage (set of player IDs). */
  damagedShips?: Set<string>;
  /** Ships that just exploded (single-frame trigger). */
  explodingShips?: Set<string>;
  vaporisedShips?: Set<string>; // vaporised `explodingShips`, cleared with it: vaporise blast, no hull hold
  /** Ship re-keys since the last rendered frame, as flat pairs
   *  `[from0, to0, from1, to1, ...]` (one-frame trigger, cleared by
   *  `consumeOneFrameTriggers`). A ship moves between its pilot's playerId and
   *  its shipInstanceId when someone takes or lets go of its controls (RTS
   *  Part A). The renderer moves its per-ship state (sprite, art, turrets,
   *  health bar, label, engine and shield effects, selection) to the new key
   *  instead of rebuilding it, so the hand-over doesn't flicker. Written only
   *  by `ColyseusClient.rekeyShip`. */
  pendingShipRekeys?: string[];
  /** Phase 4 (Leveling & XP, WS-B1) — one-shot level-up triggers to play this
   *  frame. Populated by `ColyseusClient`'s `ship_level_up` handler (pooled —
   *  the array's slot instances persist; `.length` truncates the logical view,
   *  Invariant #14). The renderer drains it, spawns a pooled screenspace
   *  level-up icon over the named ship (resolved by `playerId`; the owner's own
   *  ship pops the icon + opens the upgrade modal). Cleared each render frame in
   *  `consumeOneFrameTriggers` (same skip-frame gate as `explodingShips`). */
  pendingLevelUps?: Array<{ playerId: string; newLevel: number }>;
  /** Ships currently holding shift-boost AND thrust. Server-authoritative —
   *  rebuilt on every snapshot. Renderer draws an exhaust trail for each. */
  boostingShips?: Set<string>;
  /** Ships currently holding thrust (any acceleration, regardless of boost).
   *  Strict superset of `boostingShips`. Server-authoritative. Renderer
   *  draws a baseline thrust flame for each; the boost flame layers on top
   *  for ships that are also in `boostingShips`. */
  thrustingShips?: Set<string>;
  /**
   * Live hitscan beam state, **per mount**. Carries only the hit distance and
   * target id for each beam; the renderer derives the beam's geometry from
   * the local ship's lerped pose in `ships[localPlayerId]` plus each mount's
   * local offset each frame so beams stay glued to the ship during
   * prediction-correction lerps. Empty (not present in the map) when a mount
   * is not firing this frame. Cleared wholesale when the player releases the
   * fire trigger or switches to a projectile weapon.
   *
   * Multi-mount/turret refactor (Phase 2c, 2026-05-11): replaces the single
   * `liveBeam` field. For legacy single-mount fighter/scout/heavy the map
   * has exactly one entry keyed by `'forward'`.
   */
  /**
   * `dist` is the full drawn length; `solidDist` (Phase-4 P1a) is the distance up
   * to which the beam is full-strength SOLID — beyond it (to `dist`) the beam
   * fades to nothing (the "optimal range + falloff" taper: solid to the weapon's
   * optimal range, fading to 0 at its max range; clipped solid at any real hit so
   * `solidDist === dist`). Absent ⇒ the whole beam is solid (legacy look).
   */
  liveBeams?: Map<string, { dist: number; solidDist?: number; hitId?: string }>;
  /**
   * The local ship's active-weapon mount ids while a hostile is in that
   * weapon's range (empty otherwise). The new look shows aim guides only for
   * these. A reused array owned by the client: read it, never keep it.
   */
  localAimMountIds?: readonly string[];
  /** Fire control: the active group's reach (world units) — the length of the
   *  smart-aim guideline. */
  localAimReach?: number;
  /** Fire control: the local pilot's weapon groups with
   *  their lock queues (t target key, s stage, p progress 0..100), from the
   *  own-ship snapshot. Drives the lock rings + group-coloured brackets. */
  localGroups?: ReadonlyArray<{ id: string; m: number; l: ReadonlyArray<{ t: string; s: number; p: number; r?: number }> }>;
  /** Fire control: the group new locks go to (its colour leads the HUD). */
  localActiveGroupId?: string | null;
  /** Fire control: the smart-aim guideline while the pilot drags (world
   *  bearing in radians; NaN = not dragging) and the target it would lock. */
  localLockGuide?: number;
  localLockCandidate?: string | null;
  /** Fire control: NPCs locking the local pilot (own-ship `lockedBy` slice, shared ref).
   *  `t` = `s:<entityId>`, `s` 1 acquiring / 2 locked, `p` 0..100. */
  localLockedBy?: ReadonlyArray<{ t: string; s: number; p: number }>;
  /** Fire control: how many NPCs lock the local pilot in all (`lockedByN`);
   *  0 ⇒ the `localLockedBy` rows are everyone. The rows are only the nearest. */
  localLockedByTotal?: number;
  /** How many of those hold a completed lock (`lockedByL`); 0 ⇒ the locked
   *  `localLockedBy` rows are all of them. */
  localLockedByLocked?: number;
  /** When false, the renderer hides the orange server-ghost diamond. Default true. */
  showServerGhost?: boolean;
  /**
   * Server-authoritative beams from remote shooters (players and drones).
   * Keyed by `shooterId`, with a nested map keyed by `mountId` so multi-mount
   * shooters can carry one entry per barrel simultaneously without each new
   * mount's beam clobbering the previous one (the pre-2c structure was a
   * single beam per shooter, which dropped all-but-the-last on multi-mount
   * fires). For player shooters, the renderer derives geometry from the
   * shooter's live pose in `mirror.ships` plus the firing mount's local
   * offset each frame, so the beam sweeps with rotation; for non-ship
   * shooters (drones — not in `mirror.ships`), the renderer falls back to
   * the server-shipped `fromX/fromY/toX/toY` endpoints.
   *
   * Legacy single-mount ships emit one event with `mountId === 'forward'`
   * (or absent — pre-2c clients accept either and synthesise the same key).
   */
  remoteLasers?: Map<string, Map<string, {
    range: number;
    hit: boolean;
    targetId?: string;
    expiresAt: number;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    /** A styled (heavy) beam's client ray length this frame: from the
     *  barrel tip down the LIVE barrel to the first thing it meets (else
     *  the weapon's range). Absent ⇒ the turret's live angle is unknown;
     *  the renderer aims at `toX/toY` instead. */
    dist?: number;
  }>>;
}
