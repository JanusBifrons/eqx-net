import type { FleetPickResultWire } from './IFleetView.js';

/**
 * Renderer → main-thread feedback channel.
 *
 * The renderer writes this once per frame at the end of `update()`. The
 * caller reads it synchronously after each `update()` returns. This is
 * a closed-set of fields — adding a new one requires a phase-gate
 * review because every entry expands the worker → main per-frame
 * postMessage payload once the renderer moves off the main thread.
 *
 * **In the worker future** (see plan
 * `~/.claude/plans/humble-strolling-coral.md` Phase 2 / Phase 4):
 * the renderer lives in a Web Worker; this struct travels back to the
 * main thread via a FEEDBACK postMessage each frame and the main-thread
 * proxy caches it. Sync `getFeedback()` reads from the cache.
 *
 * Fields are kept primitive / structured-cloneable so the future
 * postMessage hop costs nothing.
 */
export interface RendererFeedback {
  /**
   * Per-ship mount-sprite count. E2E test attribute `data-mount-count`
   * reads this (looks up the local ship by id). Test-only surface —
   * not consumed by gameplay logic.
   */
  mountCounts: Map<string, number>;
  /**
   * Count of currently-visible off-screen halo arrows (HaloRadar).
   * E2E test attribute `data-haloArrowCount` reads this.
   */
  haloArrowCount: number;
  /**
   * Number of floating damage-number texts currently alive (spawned
   * but lifetime not yet expired). Lets integration tests observe
   * spawn → tick → expiry without needing pixel-level rendering
   * assertions. Lifetime = 60 frames; at the worker's 30 Hz mirror
   * cadence that's 2 s of wall-clock.
   */
  damageNumberActiveCount: number;
  /**
   * Number of shield-aura rings currently DRAWN (visible) this frame. A ring
   * is registered via `setContinuous(id,'shield',…)` but only becomes visible
   * once the effects subsystem resolves the entity's pose — so this is the
   * drawn-artefact signal (NOT the registered count). Lets the worker-boundary
   * lingering-render probe assert a parked hull's shield aura actually draws
   * (P3.12 / WS-C3): pre-fix `getEntityPose` returned null for lingering hulls
   * (their sprites lived in a separate map before RTS Part A S3), so the ring
   * registered but stayed `visible=false` → this count was 0. Mirrors
   * `damageNumberActiveCount` as a test-observable.
   */
  shieldRingVisibleCount: number;
  /**
   * Latches `true` the first time the renderer's `update()` runs with a
   * non-null `mirror.localPlayerId` AND `mirror.ships.size > 0`. Stays
   * true for the lifetime of the renderer instance.
   *
   * Drives the join-render readiness gate (`useGameReady` + WarpScreen
   * overlay) so the player never sees the partial-mount state between
   * MUI HUD render and the first frame with the local ship at its
   * correct pose. The main thread also observes the false→true
   * transition to fire the `pixi_first_frame` diagnostic event.
   */
  firstFrameRendered: boolean;
  /**
   * True once nothing drawn this frame is still waiting for its Machined art
   * (every art handle is ready or failed), or when the Machined look is off.
   * Gates `client_ready`, so the join / arrival loading screen stays up until
   * the scene is drawn in its real look (smoke test 2026-11-05: "it shouldn't
   * let me load in until I'm loaded in"). A failed bake counts as done, so a
   * broken texture can never hold the loading screen.
   */
  artReady: boolean;
  /**
   * World-space origin of the local player's first live hitscan beam as
   * ACTUALLY DRAWN this frame (the `BeamSpritePool` sprite transform),
   * or `null` when no live beam is on screen. E2E test attribute
   * `data-beam-rendered-from-x/y` reads this.
   *
   * Distinct from `data-beam-from-x/y` (which RECOMPUTES the origin from
   * the live ship pose in `gameRafLoop`): that recompute tracks the ship
   * perfectly and passes even when the drawn beam is frozen, so it cannot
   * catch the render-cache detach bug (smoke handoff 2026-06-06, Issue 1
   * Bug #1). Reading the real sprite transform is the only observable that
   * fails when the beam stops being redrawn. Test-only surface — not
   * consumed by gameplay logic.
   */
  liveBeamRenderedFromX: number | null;
  liveBeamRenderedFromY: number | null;
  /**
   * Screen-space (CSS px, canvas-relative) projection of the current structure
   * placement preview pose (`RenderMirror.pendingPlacementPreview`), or `null`
   * when there's no preview / it's off-screen. Lets the world-anchored
   * placement confirm (`StructurePlacementBanner`) sit at the blueprint's
   * on-screen position instead of a fixed HUD slot (smoke handoff 2026-06-06,
   * Issue 5). Published as `data-placement-screen-x/y`. Test-only / UI-position
   * surface — not consumed by gameplay logic.
   */
  placementScreenX: number | null;
  placementScreenY: number | null;
  /**
   * WS-9 (R2.30) — the on-screen point just ABOVE the currently-SELECTED entity
   * (any kind), or null when nothing is selected / it's off-screen. Lets the
   * `EntityStatsPanel` float over the entity in world-space instead of a fixed
   * HUD slot. Published as `data-selection-screen-x/y`. UI-position surface only.
   */
  selectionScreenX: number | null;
  selectionScreenY: number | null;
  /**
   * Tap/drag-to-position placement (2026-06-07). The renderer owns the
   * pointer-follow because it holds the camera (`screenToWorld`) and sees
   * pointer events on BOTH the main-thread and worker paths.
   * `placementChosenWorldX/Y` is the GAME-space point the blueprint is being
   * positioned at (pointer-driven; falls back to the ahead-of-ship preview
   * before the player interacts) — read by the Confirm send. `placementStuck`
   * is true once the pointer is released (the ghost is parked) — the Confirm
   * banner is shown only then, so it never sits under a dragging finger.
   * Both `null`/`false` when not in placement mode.
   */
  placementChosenWorldX: number | null;
  placementChosenWorldY: number | null;
  placementStuck: boolean;
  /**
   * WS-10 (R2.5) — DESKTOP one-click placement. A monotonic counter the renderer
   * bumps each time a MOUSE left-click (pointerup, button 0, pointerType 'mouse')
   * lands while placement is active — i.e. the player clicked to COMMIT the
   * blueprint at the cursor. `gameRafLoop` edge-detects a change and commits the
   * placement at `placementChosenWorldX/Y`, then clears `placementKind`. A
   * monotonic seq (not a one-shot bool) is robust to the worker FEEDBACK cache
   * being read across several RAFs before the next post — the value only changes
   * on a real click, so the drain fires exactly once per click. TOUCH never bumps
   * it (touch keeps the tap-to-position → Confirm-banner flow). Starts at 0.
   */
  placementConfirmSeq: number;
  /**
   * Helm orders (capital-ship R&D round 3 D). A capital pilot's tap on empty
   * space sets a course point (game space, y up); the renderer bumps the seq
   * and the main thread edge-detects it, like `placementConfirmSeq`.
   */
  helmCourseSeq: number;
  helmCourseX: number;
  helmCourseY: number;
  /**
   * RTS command view (slice 13a). The renderer owns the own-ship fleet
   * selection; `fleetSelSeq` bumps whenever it changes and `fleetSelIds` is
   * then replaced (a fresh array per change, never mutated in place), so the
   * main thread edge-detects on the seq. Ids follow the pick convention
   * (active ship = playerId, lingering hull = shipInstanceId).
   */
  fleetSelSeq: number;
  fleetSelIds: readonly string[];
  /**
   * RTS command view (slice 13a): the latest order given with a right-click
   * (mouse) in command view. `orderSeq` bumps per order; `orderX/Y` is the
   * GAME-space point; `orderTargetId` is set for an attack order, else null.
   */
  orderSeq: number;
  orderKind: 'move' | 'attack';
  orderX: number;
  orderY: number;
  orderTargetId: string | null;
  /**
   * RTS slice 10: a double tap / double click on one of your own parked ships
   * in command view = take the controls of it. `takeControlsSeq` bumps per
   * double tap; `takeControlsId` is the ship (lingering hull shipInstanceId).
   * The main thread sends `pilot_ship` once per seq.
   */
  takeControlsSeq: number;
  takeControlsId: string | null;
  /**
   * RTS slice 14b: "pick on the map" for patrol / escort / retreat.
   * `fleetPickPoints` is the number of patrol waypoints picked so far (the
   * points stay in the renderer). `fleetPickSeq` bumps when a pick finishes;
   * `fleetPickResult` is then replaced (never mutated), and the main thread
   * sends it once as `set_mode` for the selection.
   */
  fleetPickPoints: number;
  fleetPickSeq: number;
  fleetPickResult: FleetPickResultWire | null;
  /**
   * Structure placement connection-range preview (structures follow-up Item C).
   * The number of existing structures the placement ghost WOULD connect to if
   * placed at its current position — computed by the `ConnectorRenderer` preview
   * pass with the SAME obstacle-aware `canConnect` the server runs on placement
   * (so the preview matches reality). `0` when there is no active preview or the
   * ghost is out of range / blocked from every hub. Published as
   * `data-placement-preview-conn-count`. Test-only / UI-affordance surface — not
   * consumed by gameplay logic.
   */
  placementPreviewConnectionCount: number;
  /**
   * Click-to-inspect selection (structures follow-up Item B2). The renderer
   * owns the selected entity (set on a gameplay tap that resolves to an
   * entity via `pickEntityAt`, toggled off on re-tap, cleared on empty-space
   * tap) and publishes its id here so the main thread can mirror it into the
   * discrete Zustand `selection.focusId` (panel visibility). `null` when nothing
   * is selected. The id form matches the `HealthBarManager` lookup convention:
   * `playerId` for a ship, `swarm-<entityId>` for a drone/structure. Non-spatial
   * / UI-affordance surface — not consumed by gameplay logic.
   */
  selectedPickId: string | null;
  /** Kind of the selected entity (drives the stats-channel routing: only
   *  `ship`/`structure` use the server `entity_stats` channel; `drone`
   *  reads health from the mirror directly). `null` when nothing is selected. */
  selectedPickKind: 'ship' | 'drone' | 'structure' | 'asteroid' | 'lingering' | null;
  /**
   * WS-10 (R2.4) — the id of the entity the desktop pointer is HOVERING over
   * (set from pointer-move via `pickEntityAt`), or null when the cursor is over
   * empty space / on touch (no hover). Drives the lighter `HoverBracket` outline
   * and is published as `data-hover-pick-id` for the E2E. Renderer-local /
   * UI-affordance only — NEVER mirrored into Zustand (it updates at pointer-move
   * cadence; invariant #2). Same id form as `selectedPickId`.
   */
  hoveredPickId: string | null;
  /**
   * Number of mining beams (`laser_fired` with `mountId === 'drill'`) currently
   * drawn in the DEDICATED amber mining-beam pool (`_miningBeamPool`), as
   * ACTUALLY rendered this frame (the pool's `liveCount`). WS-4 Phase 4 / R2.27.
   *
   * A dedicated pool (separate from the combat `_remoteBeamPool`) is what lets
   * an E2E isolate the mining beam — `liveBeamRenderedFromX` / the shared remote
   * pool can't distinguish a drill beam from a turret/laser beam. Published as
   * `data-mining-beam-count`. Reads the real drawn-sprite count, never a
   * recompute (the "test observable reads actual output" rule). Test-only
   * surface — not consumed by gameplay logic.
   */
  miningBeamCount: number;
  /**
   * The camera: its centre in game space and the larger half of the visible
   * world (game units; 0 before the first frame). The cut field draws around
   * it as well as the own ship (`CutFieldClient.setView`), so the command
   * view panned away, or a far zoom, still shows rocks. Phase-gate review:
   * three numbers a frame on the worker post.
   */
  viewX: number;
  viewY: number;
  viewHalf: number;
}
