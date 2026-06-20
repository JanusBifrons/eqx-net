/**
 * Zustand store type definitions. Extracted from `state/store.ts` per the
 * god-file refactor plan (`docs/plans/refactor-god-files.md`, commit 6).
 * The store creation and setters stay in `state/store.ts`; this file just
 * carries the types so consumers can `import type { ... }` without
 * pulling in the runtime store and its initialisation side effects.
 *
 * NOTE: the lint glob that blocks spatial field names lives at
 * `eslint.config.js` and currently targets `src/client/state/store.ts`.
 * A future expansion should target both files. For now, the UIStore
 * interface IS in this file, so any spatial-field-named property would
 * land here — keep the same naming discipline.
 */

import type { ArrivalMode } from '../settings/settingsStorage.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import type { StructureKindId } from '../../shared-types/structureKinds.js';
import type { SectorLiveState } from '../../shared-types/galaxySnapshot.js';
import type { SectorStructurePresence } from '../../shared-types/galaxyPresence.js';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

/** A pending warp-in warning shown in the HUD (wave-system Phase 5). Purity-
 *  clean — no spatial fields. The countdown is `countdownMs` measured from the
 *  client `observedAtMs` anchor (first-observation, server-clock-skew-free). */
/** WS-10... WS-11 (R2.21) — who's warping in, relative to the local player, so
 *  the persistent warp indicator can colour by threat (hostile=red, neutral=amber,
 *  friendly=green). A discrete enum (not spatial) — Zustand-safe (#2). Today every
 *  live warning is a hostile drone wave, so the store defaults absent → 'hostile'. */
export type WarpRelation = 'hostile' | 'neutral' | 'friendly';

export interface WarpWarning {
  id: string;
  label: string;
  count: number;
  countdownMs: number;
  /** `performance.now()` when the client received the warning. */
  observedAtMs: number;
  /** Threat relation → banner colour (R2.21). Defaults to 'hostile' in the store
   *  setter when absent (every live producer is a hostile wave). */
  relation: WarpRelation;
}

/**
 * Server-health gate state for the pre-game UI (2026-05-13).
 *
 * Distinct from `ConnectionStatus` (which tracks the Colyseus WebSocket
 * lifecycle once a join is in flight). `serverHealth` is the HTTP-level
 * "is the server process even up?" probe that runs while the player is
 * on the landing / auth / galaxy-map screens, polled by
 * `serverHealthPoller`. Two distinct surfaces avoid the temptation to
 * conflate "WS dropped mid-game" with "server never came up to begin
 * with" — they need different UX (in-game vs landing banner).
 *
 * - `unknown` — initial state, no poll has completed yet.
 * - `healthy` — last poll returned a valid response AND `ready === true`.
 * - `warming` — last poll returned a valid response but `ready === false`
 *               (server is up, mid-boot). Join CTA disabled with a
 *               softer "Starting up..." banner.
 * - `unreachable` — last poll failed (network error, non-2xx, malformed
 *                   response, timeout). Join CTA disabled, error banner.
 */
export type ServerHealth = 'unknown' | 'healthy' | 'warming' | 'unreachable';

/**
 * Phase 5 — singleton roster cache. Holds the player's ship roster as
 * delivered by `/dev/player-ships` (initial fetch) and refreshed by the
 * `SHIP_ROSTER` Colyseus push. Replaces the per-`ShipRosterPanel` local
 * state so multiple panels (galaxy-map landing, drawer galaxy tab) do
 * not each fire their own fetch (Risk 0b in the Phase 5 plan).
 *
 * The shape mirrors `RosterShipEntry` in `components/ShipRosterCard.tsx`,
 * which is the JSON returned by the diag endpoint.
 */
export interface RosterEntry {
  shipId: string;
  kind: string;
  kindVersion: number;
  health: number;
  sectorKey: string;
  x: number;
  y: number;
  isActive: boolean;
  activeRoomId?: string | null;
  expiresAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

/** Phase 8 sub-phase B — client-side mirror of the transit lifecycle. */
export type TransitState = 'DOCKED' | 'SPOOLING' | 'IN_TRANSIT' | 'ARRIVED';

/**
 * Phase 4 (Spectator / Construction mode, WS-0) — whether the local player is
 * actively piloting a ship (`pilot`) or free-roaming the sector as an
 * invulnerable, un-networked local camera with full construction (`spectator`).
 * A discrete enum (NOT spatial — the free-roam camera position lives in the
 * render mirror, never the store) → Zustand-safe (#2). WS-0 only adds the flag
 * + its setter with a `pilot` default; the death→spectate transition, the
 * free-roam camera/input, and the speed-dial toggle are owned by WS-A1. */
export type PilotMode = 'pilot' | 'spectator';

/**
 * Top-level UX phase. Lifted to Zustand so drawer tabs (Profile Logout,
 * Settings "Return to menu") can change it without prop-drilling through
 * App → ... → tab.
 */
export type Phase = 'meta' | 'auth' | 'galaxy-map' | 'connecting' | 'game' | 'local';

export interface DevData {
  rtt: number;
  drift: number;
  angleDrift: number;
  lerping: boolean;
  snapshotIntervalMs: number;
  ticksAhead: number;
  snapshotCount: number;
  significantCorrectionCount: number;
  significantAngleCorrectionCount: number;
  maxDriftUnits: number;
  maxAngleDriftRad: number;
  // Extended diagnostics
  ackedTick: number;
  inputTick: number;
  serverTick: number;
  serverX: number;
  serverY: number;
  beforeX: number;
  beforeY: number;
  afterX: number;
  afterY: number;
}

/** Rolling-30 s health stats — paradigm plan (quirky-rabbit) Phase 6.
 *  Published once per second from `src/client/debug/healthStats.ts`'s
 *  publisher. The DevOverlay surfaces both windows; consumers should
 *  treat 0 as "no recent events" not "metric unavailable". */
export interface UIHealthStats {
  /** Server major-GC pauses received via the `gc_pause` Colyseus
   *  broadcast. Only MSC pauses cross the 5 ms threshold; Scavenge is
   *  filtered out server-side. */
  serverGc: { count30s: number; maxMs30s: number };
  /** Browser longtask events (>50 ms) from `PerformanceObserver`.
   *  Includes GC pauses on the JS thread, but also any other blocking
   *  work — honest about what it measures (not "allocation rate"). */
  longtask: { count30s: number; maxMs30s: number };
}

export interface UIStore {
  connectionStatus: ConnectionStatus;
  sectorName: string;
  hullPct: number;
  /** Local ship shield 0-100. Discrete UI scalar (purity-clean), set
   *  from DamageEvent / ShieldEventMessage anchors; the HUD bar CSS-tweens
   *  between anchors (locked: no continuous shield wire traffic). */
  shieldPct: number;
  ammo: number;
  sectorAlert: string | null;
  /** Wave-system Phase 5 — pending warp-in warnings for THIS sector (a drone
   *  squad or a player spooling in). Purity-clean: count/label/timing only, NO
   *  positions (invariant #2). The banner ticks down from `countdownMs` anchored
   *  at the client `observedAtMs` (first-observation, avoids server-clock skew). */
  warpWarnings: WarpWarning[];
  playerId: string | null;
  showDevOverlay: boolean;
  showLogPanel: boolean;
  showServerGhost: boolean;
  /** Auto-fire mode (default ON, persisted): weapons fire automatically at
   *  in-range hostiles. When OFF, the manual FIRE button / Space-key returns. */
  autoFireEnabled: boolean;
  /** Player's chosen ship kind for the next spawn. Persisted per-user via
   *  `shipSelectionStorage`. Defaults to `DEFAULT_SHIP_KIND` until the user
   *  picks one or `applyUserPrefs(userId)` re-reads from storage. */
  selectedShipKind: ShipKindId;
  shipCount: number;
  /** Live count of swarm entities (asteroids + drones) in `mirror.swarm`. */
  swarmCount: number;
  /** Phase 6 TiDi rate broadcast by the server (1.0 = normal, 0.7 = floor). */
  clockRate: number;
  /** Effective server wall-clock tick rate, derived from snapshot inter-arrival
   *  intervals. 60 Hz = healthy; <50 Hz means the server's `update()` is
   *  running over budget, which is a different failure mode than TiDi. */
  serverTickHz: number;
  devData: DevData;
  /** Paradigm plan (quirky-rabbit) Phase 6 — rolling 30 s GC/longtask
   *  stats, published once per second from `healthStats.ts`. */
  healthStats: UIHealthStats;
  /** Fraction 0–1 of snapshots that triggered a significant correction. Always-visible HUD stat. */
  correctionRate: number;
  /** True when the local ship has been destroyed and is awaiting respawn. */
  isDead: boolean;
  /** Phase 4 (Spectator / Construction mode, WS-0) — `pilot` (driving a ship)
   *  vs `spectator` (free-roam construction camera). Discrete enum, purity-clean
   *  (#2). Defaults to `pilot`; WS-A1 flips it on death + via the speed-dial
   *  toggle. WS-0 lands only the flag + setter. */
  pilotMode: PilotMode;
  /** Phase 8 — stable galaxy sector key the player is currently in (set
   *  from the welcome message), or null in engineering rooms. */
  currentSectorKey: string | null;
  /** Phase 8 — current transit lifecycle state. Drives the HyperspaceOverlay. */
  transitState: TransitState;
  /** Phase 8 — 0..1 spool progress; only meaningful while transitState === 'SPOOLING'. */
  transitProgress: number;
  /** Phase 8 — destination sector key during a transit (SPOOLING/IN_TRANSIT/ARRIVED). */
  transitTargetSectorKey: string | null;
  /** Total spool duration in ms reported by the server (only set while
   *  SPOOLING). Used by `HyperspaceOverlay` to render an ms-precision
   *  countdown alongside the progress fill. Cleared back to null on
   *  DOCKED / ARRIVED. */
  transitSpoolMs: number | null;
  /** Currently selected weapon SLOT id (weapons/energy/AI overhaul §5.2).
   *  UI-only discrete selection — NOT spatial. Replaces the old per-weapon
   *  `activeWeapon`: each ship now fires its catalogue-bound loadout, and the
   *  pilot picks which *slot* is hot (today every ship has exactly one slot,
   *  so the selector shows a single toggle; forward-compatible with multi-slot
   *  ships). Threaded to the server as `FireMessage.slotId`. */
  activeSlotId: string;
  /** Structures plan (Phase 2) — the structure kind the player is about to
   *  place, or null when not in placement mode. Discrete UI selection
   *  (purity-clean: it's a kind id, not a spatial field). Set by the
   *  speed-dial Build actions; cleared on confirm / cancel. */
  placementKind: StructureKindId | null;
  /** Click-to-inspect selection (structures follow-up Item B3). The id of the
   *  entity the player tapped to inspect, or null when nothing is selected.
   *  Drives `EntityStatsPanel` VISIBILITY only — purity-clean (a discrete id
   *  string, NOT a spatial field; the live hp/shield numbers live in the
   *  non-Zustand `selectionStats` module singleton, polled by the panel). The
   *  renderer owns the selection (`RendererFeedback.selectedPickId`); the main
   *  thread mirrors transitions here on change only. */
  selectedEntityId: string | null;
  /** Kind of the selected entity — `ship`/`structure` use the server
   *  `entity_stats` channel; `drone` reads health from the render mirror
   *  directly. Null when nothing is selected. */
  selectedEntityKind: 'ship' | 'drone' | 'structure' | 'asteroid' | 'lingering' | null;
  /** The local ship's full energy pool — the denominator for the top-center
   *  EnergyBar (the fill comes per-frame from
   *  `ColyseusClient.getPredictedEnergy()`). Set once on spawn from the
   *  ship-kind catalogue; constant per kind, so it lives safely in Zustand
   *  (no per-frame churn). */
  energyMax: number;
  /** Wall-clock ms when the most-recent fire was sent (null = no fire yet,
   *  or slot switched since last fire). Stamped by `ColyseusClient.sendFire`.
   *  Per-frame readers (the fire-button cooldown ring) use this with the
   *  active slot's cooldown to render a circular progress indicator.
   *  Low-cadence — safe in Zustand without trampling React. */
  lastFireMs: number | null;
  /** Right-edge advanced drawer open state. Discrete UI flag — purity-clean. */
  isDrawerOpen: boolean;
  /** Currently active tab inside the advanced drawer (`profile` | `settings` | `galaxy` | `debug`). */
  drawerTab: string;
  /** Top-level UX phase. App.tsx routes screens off this value. */
  phase: Phase;
  /** Living Galaxy P5 — a galaxy sector picked while logged-OUT, stashed across
   *  the auth detour so the remounted GameSurface re-opens its picker on
   *  return. Discrete string id (not spatial) → Zustand-safe (#2). */
  pendingPickSector: string | null;
  /** In-game additive Pixi overlay (Map B) open state. Toggled by the new
   *  bottom-center MAP HUD button and the keyboard `M` shortcut. Renders a
   *  highly transparent galaxy hex layer ON the gameplay canvas — gameplay
   *  continues underneath. */
  isGalaxyMapOpen: boolean;
  /** Live per-sector galaxy stats (Phase 4b) from GET /galaxy/snapshot. Discrete,
   *  non-spatial → Zustand-safe (#2). Polled by useGalaxyStats while a galaxy map
   *  is on screen; consumed by the GalaxyMapLayer count glyphs. */
  galaxyStats: SectorLiveState[];
  /** Equinox Tweaks Phase 2 (#2) — false until the FIRST `/galaxy/snapshot` poll
   *  resolves. Drives a one-shot loading spinner over the galaxy map so the live
   *  count icons don't "pop in" out of sync after the hexes render. Discrete
   *  boolean → Zustand-safe (#2). */
  galaxyStatsLoaded: boolean;
  /** 2026-06-19 pop-in fix — false until the FIRST `/galaxy/presence` poll
   *  COMPLETES (success OR failure). The landing reveal gate ALSO waits on this
   *  (for a logged-in player) so the player's OWN structure badges don't pop in
   *  after the hexes + global counts. Discrete boolean → Zustand-safe (#2). */
  galaxyPresenceLoaded: boolean;
  /** 2026-06-19 pop-in fix — false until the FIRST `/dev/player-ships` roster
   *  fetch COMPLETES (success OR failure). The landing reveal gate ALSO waits on
   *  this (for a logged-in player) so the player's OWN SHIP badges (the user's
   *  "ships still pop in") don't appear after the map reveals. Discrete boolean
   *  → Zustand-safe (#2). */
  rosterLoaded: boolean;
  /** Equinox Phase 7 — the logged-in player's owned-structure count per sector,
   *  from GET /galaxy/presence (the "my structures" omnipotent overlay). Ship
   *  locations are merged in client-side from the roster. Discrete, non-spatial
   *  → Zustand-safe (#2); polled by useGalaxyPresence while a galaxy map is up. */
  galaxyOwnedStructures: SectorStructurePresence[];
  /** Living Galaxy Phase 6 — the galaxy-map sector under the desktop pointer +
   *  the screen anchor for its tooltip, or null. Deduped on sector-key change
   *  (NOT per-pointermove), so it's a discrete low-frequency UI field; the
   *  `left`/`top` are tooltip anchor px, not game-spatial → Zustand-safe (#2). */
  galaxyHover: { sectorKey: string; left: number; top: number } | null;
  /** Standalone Galaxy Overview (Map A) open state in-game. Toggled by the
   *  drawer's Galaxy tab. Replaces the gameplay canvas full-screen with a
   *  Pixi-rendered overview that supports drag/pinch/wheel pan & zoom. The
   *  Colyseus session stays alive in the background. */
  isGalaxyOverviewOpen: boolean;
  /** Hyperspace arrival mode for the next warp. UI-discrete value (3 modes),
   *  not per-frame — purity-clean. PC has no UI for this and the value
   *  stays at the `'same'` default. Persisted per-user. */
  arrivalMode: ArrivalMode;
  /** Last user-typed (or clamped) arrival x. Used when `arrivalMode==='xy'`. */
  arrivalTargetX: number;
  arrivalTargetY: number;
  /** "Home" coordinate, used when `arrivalMode==='home'`. Currently the UI
   *  pins this to 0/0; future work may let the player set it. */
  homePosX: number;
  homePosY: number;
  /** Phase 5 — singleton roster cache for the local player's ships.
   *  Populated by the diag-endpoint fetcher (one-shot at login) and
   *  refreshed by the `SHIP_ROSTER` Colyseus push (server-side abandon /
   *  transit broadcast). Consumers: `ShipRosterPanel`, `RosterCountBadge`,
   *  `GalaxyTab`. Empty array when the player has no ships. */
  shipRoster: RosterEntry[];
  /** HTTP-level `/healthz` probe state for the pre-game UI gate. Drives
   *  the landing-screen banner + join-button disabled state. */
  serverHealth: ServerHealth;
  /** Latest `playersOnline` value from `/healthz`. Null when the server
   *  hasn't replied yet or the last reply was malformed. Drives the
   *  hype-number above the Join CTA. */
  playersOnline: number | null;
  // ── Spawn handshake (plan: crispy-kazoo Commit 1) ─────────────────
  /** Set true once the client has sent the `client_ready` Colyseus
   *  message after the bootstrap gates pass (firstSnapshot + first
   *  frame + minDisplay + localPose). Idempotent — the sender guards.
   *  Reset by `commonReadinessRearm` (every sector entry/transit). */
  clientReadySent: boolean;
  /** Server-picked tick at which the joining ship becomes visible to
   *  all observers. Populated by the `warp_in` handler when the
   *  message's entityId matches the local ship. `null` until the
   *  handshake completes. */
  arrivalTickFromServer: number | null;
  /** Flips true when `serverTick >= arrivalTickFromServer` — the
   *  moment the curtain drops. Sole writer is the per-RAF check in
   *  ColyseusClient (Commit 2); WarpScreen reads it via
   *  `useIsLoadingActive`. Reset by `commonReadinessRearm`. */
  arrivalAcked: boolean;
  /** Set true the first time `tryInitPredWorld` succeeds (the local
   *  predWorld ship body exists). Discrete UI flag — purity-clean. */
  localPoseResolved: boolean;
  /** Monotonic latch for the warp-screen progress bar — prevents the
   *  displayed percentage from regressing on a transient gate flip. */
  maxProgressSeen: number;
  /** Set ONCE at boot from `?loading=cosmetic` URL param. When true,
   *  the loading curtain renders cosmetically but `computeIsLoadingActive`
   *  returns false — restores legacy "no pause" behaviour as a
   *  pre-rollout safety net. Immutable after boot. */
  loadingCosmeticOnly: boolean;
  /** Double-click guard for both the in-game Respawn button and the
   *  galaxy-screen sector-pick hex. Set true at the first click,
   *  cleared on `gameReady=true` at the destination. Prevents a
   *  second click from racing through the leave/rejoin pipeline
   *  twice. */
  sectorReentryInFlight: boolean;

  setConnectionStatus: (s: ConnectionStatus) => void;
  setSectorName: (name: string) => void;
  setHullPct: (pct: number) => void;
  setShieldPct: (pct: number) => void;
  setAmmo: (ammo: number) => void;
  setSectorAlert: (msg: string | null) => void;
  /** Add or replace a warp-in warning (keyed by id). Stamps `observedAtMs`;
   *  `relation` defaults to 'hostile' when absent (R2.21). */
  addWarpWarning: (w: {
    id: string;
    label: string;
    count: number;
    countdownMs: number;
    relation?: WarpRelation;
  }) => void;
  /** Remove a warp-in warning by id (cancel/abort or countdown elapsed). */
  removeWarpWarning: (id: string) => void;
  setPlayerId: (id: string) => void;
  setShowDevOverlay: (v: boolean) => void;
  setShowLogPanel: (v: boolean) => void;
  setShowServerGhost: (v: boolean) => void;
  setAutoFireEnabled: (v: boolean) => void;
  setSelectedShipKind: (id: ShipKindId) => void;
  toggleDevOverlay: () => void;
  setShipCount: (n: number) => void;
  setSwarmCount: (n: number) => void;
  setClockRate: (n: number) => void;
  setServerTickHz: (n: number) => void;
  setDevData: (d: DevData) => void;
  setHealthStats: (s: UIHealthStats) => void;
  setDead: (dead: boolean) => void;
  /** Phase 4 (Spectator / Construction mode, WS-0) — set the pilot/spectator
   *  mode. WS-A1 wires the death transition + the speed-dial toggle. */
  setPilotMode: (mode: PilotMode) => void;
  setCurrentSectorKey: (key: string | null) => void;
  setTransitState: (s: TransitState) => void;
  setTransitProgress: (p: number) => void;
  setTransitTargetSectorKey: (key: string | null) => void;
  setTransitSpoolMs: (ms: number | null) => void;
  setActiveSlotId: (id: string) => void;
  setPlacementKind: (k: StructureKindId | null) => void;
  /** Set the inspected entity selection (Item B3). Both args change together. */
  setSelectedEntity: (
    id: string | null,
    kind: 'ship' | 'drone' | 'structure' | 'asteroid' | 'lingering' | null,
  ) => void;
  setEnergyMax: (max: number) => void;
  setLastFireMs: (ms: number | null) => void;
  setDrawerOpen: (v: boolean) => void;
  setDrawerTab: (id: string) => void;
  setPhase: (p: Phase) => void;
  setPendingPickSector: (key: string | null) => void;
  setGalaxyMapOpen: (v: boolean) => void;
  setGalaxyStats: (stats: SectorLiveState[]) => void;
  setGalaxyStatsLoaded: (v: boolean) => void;
  setGalaxyPresenceLoaded: (v: boolean) => void;
  setRosterLoaded: (v: boolean) => void;
  setGalaxyOwnedStructures: (sectors: SectorStructurePresence[]) => void;
  setGalaxyHover: (hover: { sectorKey: string; left: number; top: number } | null) => void;
  toggleGalaxyMapOpen: () => void;
  setGalaxyOverviewOpen: (v: boolean) => void;
  toggleGalaxyOverviewOpen: () => void;
  setArrivalMode: (m: ArrivalMode) => void;
  setArrivalTarget: (x: number, y: number) => void;
  setHomePos: (x: number, y: number) => void;
  /** Phase 5 — overwrite the roster cache (server push or fetch result). */
  setShipRoster: (ships: RosterEntry[]) => void;
  /** Phase 5 — pending in-game roster swap request. GalaxyTab sets this
   *  when the user clicks Spawn on a roster card; App.tsx watches it
   *  and runs the direct-room-swap flow (NOT engageTransit). Cleared
   *  by App after dispatching. The swap is a leave-current + join-new
   *  with a brief 'connecting' phase for the loading spinner — far
   *  simpler than the transit machine and not bound by neighbour-only
   *  rules. */
  pendingShipSwap: { shipId: string; sectorKey: string } | null;
  setPendingShipSwap: (req: { shipId: string; sectorKey: string } | null) => void;
  /** Phase 5 — `player_ships.ship_id` of the hull the local browser
   *  session is currently piloting. Sourced from `WelcomeMessage.
   *  shipInstanceId` on every successful room join; cleared when the
   *  player leaves a room (phase != 'game'). Distinct from the
   *  server-side `ship.isActive` flag (which stays true throughout the
   *  15-min reconnect-linger window) — `localShipInstanceId` is the
   *  THIS-session identifier the UI uses to mark "Piloting" / disable
   *  the spawn-on-self button. */
  localShipInstanceId: string | null;
  setLocalShipInstanceId: (id: string | null) => void;
  /** Join-render readiness sub-flag. Set true the first time
   *  `ColyseusClient.handleSnapshot()` runs with a non-null
   *  `mirror.localPlayerId` after (re)connect. Reset by `setPhase`
   *  enter/leave-`game` (initial join, ship-swap, respawn) AND by
   *  `rearmJoinReadiness()` on every committed inter-sector transit
   *  (which keeps `phase==='game'`, so `setPhase` never fires).
   *  Discrete UI flag — purity-clean. */
  firstSnapshotApplied: boolean;
  setFirstSnapshotApplied: (v: boolean) => void;
  /** Join-render readiness sub-flag. Set true when the renderer first
   *  paints a frame with the local player visible (observed via
   *  `RendererFeedback.firstFrameRendered` from main-thread rAF). Reset
   *  ONLY on phase change into `'game'` — NOT on a pure inter-sector
   *  transit, which keeps the same live renderer (GPU-init lag is an
   *  initial-join concern; resetting it on transit would be false). */
  rendererFirstFrameRendered: boolean;
  setRendererFirstFrameRendered: (v: boolean) => void;
  /** Minimum-display-time floor for the WarpScreen. Set true 5 s
   *  after the App.tsx timer (re)arms. Required by `useGameReady` so
   *  the warp visual shows for at least this long even when the rest of
   *  the gates fire faster — gives the reconciler enough wall-clock to
   *  apply its first correction beneath the visual, absorbing the
   *  first-move teleport user symptom. Reset by `setPhase`
   *  enter/leave-`game` AND `rearmJoinReadiness()` (the timer effect
   *  re-runs via the `joinGeneration` dep). */
  joinMinimumElapsed: boolean;
  setJoinMinimumElapsed: (v: boolean) => void;
  /** Monotone counter bumped once per "fresh sector" event — `setPhase`
   *  enter/leave-`game` AND every committed inter-sector transit
   *  (`rearmJoinReadiness`). The App.tsx 5 s `joinMinimumElapsed` timer
   *  keys its effect on this so the minimum-display floor re-runs on a
   *  pure transit (which does NOT remount GameSurface — a mount-scoped
   *  `[]` effect would never otherwise re-arm). */
  joinGeneration: number;
  /** Re-arm WarpScreen join-readiness for a NEW committed inter-sector
   *  transit: clears `firstSnapshotApplied` + `joinMinimumElapsed` and
   *  bumps `joinGeneration`. Does NOT touch `rendererFirstFrameRendered`
   *  (the renderer stays live across a transit). ONE ownership site,
   *  invoked from the `transit_ready` handler — the UI-readiness
   *  analogue of `resetPredictionState()`. A pure inter-sector transit
   *  keeps `phase==='game'` so `setPhase` never re-arms; this does.
   *  Locked by `store.rearmJoinReadiness.test.ts`,
   *  `WarpScreen.transit.test.tsx`,
   *  `ColyseusClient.transitRearmReadiness.test.ts`. */
  rearmJoinReadiness: () => void;
  /** Apply the latest `/healthz` poll result. Updates both the gate
   *  state and the cached `playersOnline` in one set so subscribers see
   *  a consistent pair. */
  setServerHealth: (health: ServerHealth, playersOnline?: number | null) => void;
  // ── Spawn handshake setters (plan: crispy-kazoo Commit 1) ─────────
  setClientReadySent: (v: boolean) => void;
  setArrivalTickFromServer: (tick: number | null) => void;
  setArrivalAcked: (v: boolean) => void;
  setLocalPoseResolved: (v: boolean) => void;
  setMaxProgressSeen: (p: number) => void;
  setLoadingCosmeticOnly: (v: boolean) => void;
  setSectorReentryInFlight: (v: boolean) => void;
}
