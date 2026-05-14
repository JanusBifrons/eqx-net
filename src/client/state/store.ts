import { create } from 'zustand';
import { loadSettings, saveSettings, type ArrivalMode } from '../settings/settingsStorage.js';
import { loadShipKind, saveShipKind } from '../settings/shipSelectionStorage.js';
import type { UserId } from '../settings/userPrefs.js';
import { DEFAULT_SHIP_KIND, type ShipKindId } from '../../shared-types/shipKinds.js';
import { DEFAULT_WEAPON, WEAPON_IDS, type WeaponId } from '../../core/combat/WeaponCatalogue.js';

export type { ArrivalMode } from '../settings/settingsStorage.js';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

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
 * Top-level UX phase. Lifted to Zustand so drawer tabs (Profile Logout,
 * Settings "Return to menu") can change it without prop-drilling through
 * App → ... → tab.
 */
export type Phase = 'meta' | 'auth' | 'galaxy-map' | 'connecting' | 'game' | 'local';

interface DevData {
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

interface UIStore {
  connectionStatus: ConnectionStatus;
  sectorName: string;
  hullPct: number;
  ammo: number;
  sectorAlert: string | null;
  playerId: string | null;
  showDevOverlay: boolean;
  showLogPanel: boolean;
  showServerGhost: boolean;
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
  /** Fraction 0–1 of snapshots that triggered a significant correction. Always-visible HUD stat. */
  correctionRate: number;
  /** True when the local ship has been destroyed and is awaiting respawn. */
  isDead: boolean;
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
  /** Currently selected weapon. UI-only discrete selection — NOT spatial. */
  activeWeapon: WeaponId;
  /** Right-edge advanced drawer open state. Discrete UI flag — purity-clean. */
  isDrawerOpen: boolean;
  /** Currently active tab inside the advanced drawer (`profile` | `settings` | `galaxy` | `debug`). */
  drawerTab: string;
  /** Top-level UX phase. App.tsx routes screens off this value. */
  phase: Phase;
  /** In-game additive Pixi overlay (Map B) open state. Toggled by the new
   *  bottom-center MAP HUD button and the keyboard `M` shortcut. Renders a
   *  highly transparent galaxy hex layer ON the gameplay canvas — gameplay
   *  continues underneath. */
  isGalaxyMapOpen: boolean;
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

  setConnectionStatus: (s: ConnectionStatus) => void;
  setSectorName: (name: string) => void;
  setHullPct: (pct: number) => void;
  setAmmo: (ammo: number) => void;
  setSectorAlert: (msg: string | null) => void;
  setPlayerId: (id: string) => void;
  setShowDevOverlay: (v: boolean) => void;
  setShowLogPanel: (v: boolean) => void;
  setShowServerGhost: (v: boolean) => void;
  setSelectedShipKind: (id: ShipKindId) => void;
  toggleDevOverlay: () => void;
  setShipCount: (n: number) => void;
  setSwarmCount: (n: number) => void;
  setClockRate: (n: number) => void;
  setServerTickHz: (n: number) => void;
  setDevData: (d: DevData) => void;
  setDead: (dead: boolean) => void;
  setCurrentSectorKey: (key: string | null) => void;
  setTransitState: (s: TransitState) => void;
  setTransitProgress: (p: number) => void;
  setTransitTargetSectorKey: (key: string | null) => void;
  setTransitSpoolMs: (ms: number | null) => void;
  setActiveWeapon: (id: WeaponId) => void;
  cycleWeapon: () => void;
  setDrawerOpen: (v: boolean) => void;
  setDrawerTab: (id: string) => void;
  setPhase: (p: Phase) => void;
  setGalaxyMapOpen: (v: boolean) => void;
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
   *  `mirror.localPlayerId` after (re)connect. Reset to false whenever
   *  `setPhase` puts the app into `'game'` (initial join, ship-swap
   *  arrival, transit arrival). Discrete UI flag — purity-clean. */
  firstSnapshotApplied: boolean;
  setFirstSnapshotApplied: (v: boolean) => void;
  /** Join-render readiness sub-flag. Set true when the renderer first
   *  paints a frame with the local player visible (observed via
   *  `RendererFeedback.firstFrameRendered` from main-thread rAF). Reset
   *  on phase change into `'game'`. */
  rendererFirstFrameRendered: boolean;
  setRendererFirstFrameRendered: (v: boolean) => void;
  /** Apply the latest `/healthz` poll result. Updates both the gate
   *  state and the cached `playersOnline` in one set so subscribers see
   *  a consistent pair. */
  setServerHealth: (health: ServerHealth, playersOnline?: number | null) => void;
}

// The store is constructed before auth resolves, so we hydrate from the
// anonymous slot first. `applyUserPrefs(userId)` is called from App.tsx once
// `useAuthStore.user` is known and re-reads from the per-user slot. If you
// log in for the first time on a device, the legacy `eqxSettings` global key
// migrates into the per-user slot on that re-read (see `userPrefs.ts`).
const initialPersisted     = loadSettings(null);
const initialShipKind      = loadShipKind(null);
const initialDevOverlay    = initialPersisted.showDevOverlay   ?? true;
const initialLogPanel      = initialPersisted.showLogPanel     ?? true;
const initialServerGhost   = initialPersisted.showServerGhost  ?? true;
const initialArrivalMode   = initialPersisted.arrivalMode      ?? 'same';
const initialArrivalTargetX = initialPersisted.arrivalTargetX  ?? 0;
const initialArrivalTargetY = initialPersisted.arrivalTargetY  ?? 0;
const initialHomePosX      = initialPersisted.homePosX         ?? 0;
const initialHomePosY      = initialPersisted.homePosY         ?? 0;

/** Tracks which user the store is currently persisting under, so setters can
 *  target the right `localStorage` slot without each setter taking a userId
 *  argument. Updated by `applyUserPrefs`. */
let activeUserId: UserId = null;

function persistSettings(
  state: Pick<
    UIStore,
    | 'showDevOverlay'
    | 'showLogPanel'
    | 'showServerGhost'
    | 'arrivalMode'
    | 'arrivalTargetX'
    | 'arrivalTargetY'
    | 'homePosX'
    | 'homePosY'
  >,
): void {
  saveSettings(activeUserId, {
    showDevOverlay:  state.showDevOverlay,
    showLogPanel:    state.showLogPanel,
    showServerGhost: state.showServerGhost,
    arrivalMode:     state.arrivalMode,
    arrivalTargetX:  state.arrivalTargetX,
    arrivalTargetY:  state.arrivalTargetY,
    homePosX:        state.homePosX,
    homePosY:        state.homePosY,
  });
}

export const useUIStore = create<UIStore>((set, get) => ({
  connectionStatus: 'disconnected',
  sectorName: '',
  hullPct: 100,
  ammo: 20,
  sectorAlert: null,
  playerId: null,
  showDevOverlay: initialDevOverlay,
  showLogPanel: initialLogPanel,
  showServerGhost: initialServerGhost,
  selectedShipKind: initialShipKind,
  shipCount: 0,
  swarmCount: 0,
  clockRate: 1.0,
  serverTickHz: 60,
  devData: { rtt: 0, drift: 0, angleDrift: 0, lerping: false, snapshotIntervalMs: 0, ticksAhead: 0, snapshotCount: 0, significantCorrectionCount: 0, significantAngleCorrectionCount: 0, maxDriftUnits: 0, maxAngleDriftRad: 0, ackedTick: 0, inputTick: 0, serverTick: 0, serverX: 0, serverY: 0, beforeX: 0, beforeY: 0, afterX: 0, afterY: 0 },
  correctionRate: 0,
  isDead: false,
  currentSectorKey: null,
  transitState: 'DOCKED',
  transitProgress: 0,
  transitTargetSectorKey: null,
  transitSpoolMs: null,
  activeWeapon: DEFAULT_WEAPON,
  isDrawerOpen: false,
  drawerTab: 'galaxy',
  phase: 'meta',
  isGalaxyMapOpen: false,
  isGalaxyOverviewOpen: false,
  arrivalMode: initialArrivalMode,
  arrivalTargetX: initialArrivalTargetX,
  arrivalTargetY: initialArrivalTargetY,
  homePosX: initialHomePosX,
  homePosY: initialHomePosY,
  shipRoster: [],
  pendingShipSwap: null,
  localShipInstanceId: null,
  firstSnapshotApplied: false,
  rendererFirstFrameRendered: false,
  serverHealth: 'unknown',
  playersOnline: null,

  setConnectionStatus: (s) => set({ connectionStatus: s }),
  setSectorName: (name) => set({ sectorName: name }),
  setHullPct: (pct) => set({ hullPct: pct }),
  setAmmo: (ammo) => set({ ammo }),
  setSectorAlert: (msg) => set({ sectorAlert: msg }),
  setPlayerId: (id) => set({ playerId: id }),
  setShowDevOverlay:  (v) => { set({ showDevOverlay:  v }); persistSettings(get()); },
  setShowLogPanel:    (v) => { set({ showLogPanel:    v }); persistSettings(get()); },
  setShowServerGhost: (v) => { set({ showServerGhost: v }); persistSettings(get()); },
  setSelectedShipKind: (id) => { set({ selectedShipKind: id }); saveShipKind(activeUserId, id); },
  toggleDevOverlay: () => { set((s) => ({ showDevOverlay: !s.showDevOverlay })); persistSettings(get()); },
  setShipCount: (n) => set({ shipCount: n }),
  setSwarmCount: (n) => set({ swarmCount: n }),
  setClockRate: (n) => set({ clockRate: n }),
  setServerTickHz: (n) => set({ serverTickHz: n }),
  setDevData: (d) => set({
    devData: d,
    correctionRate: d.snapshotCount > 0 ? d.significantCorrectionCount / d.snapshotCount : 0,
  }),
  setDead: (dead) => set({ isDead: dead }),
  setCurrentSectorKey: (key) => set({ currentSectorKey: key }),
  setTransitState: (s) => set({ transitState: s }),
  setTransitProgress: (p) => set({ transitProgress: p }),
  setTransitTargetSectorKey: (key) => set({ transitTargetSectorKey: key }),
  setTransitSpoolMs: (ms) => set({ transitSpoolMs: ms }),
  setActiveWeapon: (id) => set({ activeWeapon: id }),
  cycleWeapon: () => set((s) => {
    const idx = WEAPON_IDS.indexOf(s.activeWeapon);
    return { activeWeapon: WEAPON_IDS[(idx + 1) % WEAPON_IDS.length]! };
  }),
  setDrawerOpen: (v) => set({ isDrawerOpen: v }),
  setDrawerTab: (id) => set({ drawerTab: id }),
  setPhase: (p) => set((prev) => {
    // Join-render readiness reset: every entry into 'game' (initial
    // join, ship-swap arrival, transit arrival) re-arms the WarpScreen
    // overlay by clearing both readiness sub-flags. Leaving 'game'
    // also clears them so a subsequent re-entry doesn't see stale
    // post-arrival flags carried over.
    if (p === 'game' && prev.phase !== 'game') {
      return { phase: p, firstSnapshotApplied: false, rendererFirstFrameRendered: false };
    }
    if (p !== 'game' && prev.phase === 'game') {
      return { phase: p, firstSnapshotApplied: false, rendererFirstFrameRendered: false };
    }
    return { phase: p };
  }),
  setGalaxyMapOpen: (v) => set({ isGalaxyMapOpen: v }),
  toggleGalaxyMapOpen: () => set((s) => ({ isGalaxyMapOpen: !s.isGalaxyMapOpen })),
  setGalaxyOverviewOpen: (v) => set({ isGalaxyOverviewOpen: v }),
  toggleGalaxyOverviewOpen: () => set((s) => ({ isGalaxyOverviewOpen: !s.isGalaxyOverviewOpen })),
  setArrivalMode:   (m) => { set({ arrivalMode: m }); persistSettings(get()); },
  setArrivalTarget: (xv, yv) => { set({ arrivalTargetX: xv, arrivalTargetY: yv }); persistSettings(get()); },
  setHomePos:       (xv, yv) => { set({ homePosX: xv, homePosY: yv }); persistSettings(get()); },
  setShipRoster:    (ships) => set({ shipRoster: ships }),
  setPendingShipSwap: (req) => set({ pendingShipSwap: req }),
  setLocalShipInstanceId: (id) => set({ localShipInstanceId: id }),
  setFirstSnapshotApplied: (v) => set({ firstSnapshotApplied: v }),
  setRendererFirstFrameRendered: (v) => set({ rendererFirstFrameRendered: v }),
  setServerHealth:  (health, playersOnline) => set((prev) => ({
    serverHealth: health,
    // Preserve the previous count when the caller didn't pass one
    // (e.g. an `unreachable` transition where we still want to show
    // the last-known number is gated behind `serverHealth` anyway).
    // Pass `null` explicitly to clear.
    playersOnline: playersOnline === undefined ? prev.playersOnline : playersOnline,
  })),
}));

/**
 * Join-render readiness selector — true when the player can safely see
 * the game canvas without the partial-mount intermediate states. The
 * WarpScreen overlay is visible exactly when this is `false` (in game
 * phase) and hides when it flips `true`.
 *
 * Composed from four sub-flags so each readiness gate is observable
 * independently in tests + diagnostic captures:
 *   - `connectionStatus === 'connected'` — WebSocket up.
 *   - `localShipInstanceId !== null` — server welcomed us; we have an
 *     identity to render.
 *   - `firstSnapshotApplied` — at least one snapshot tick has reached
 *     `handleSnapshot`, so the reconciler/predWorld are warmed.
 *   - `rendererFirstFrameRendered` — Pixi has painted a frame with the
 *     local player in `mirror.ships`.
 *
 * `setPhase` resets the last two flags on every entry into game phase
 * so subsequent room transitions retrigger the overlay.
 */
export function useGameReady(): boolean {
  return useUIStore(
    (s) =>
      s.connectionStatus === 'connected'
      && s.localShipInstanceId !== null
      && s.firstSnapshotApplied
      && s.rendererFirstFrameRendered,
  );
}

/**
 * Re-hydrate all per-user preferences (settings + selected ship) for the
 * given authenticated user, and route subsequent setter writes to the same
 * user's `localStorage` slot.
 *
 * Called from `App.tsx` whenever `useAuthStore.user.id` changes (login,
 * logout, account switch). Pass `null` for the anonymous slot.
 */
export function applyUserPrefs(userId: UserId): void {
  activeUserId = userId;
  const persisted = loadSettings(userId);
  const shipKind = loadShipKind(userId);
  useUIStore.setState({
    showDevOverlay:  persisted.showDevOverlay  ?? true,
    showLogPanel:    persisted.showLogPanel    ?? true,
    showServerGhost: persisted.showServerGhost ?? true,
    arrivalMode:     persisted.arrivalMode     ?? 'same',
    arrivalTargetX:  persisted.arrivalTargetX  ?? 0,
    arrivalTargetY:  persisted.arrivalTargetY  ?? 0,
    homePosX:        persisted.homePosX        ?? 0,
    homePosY:        persisted.homePosY        ?? 0,
    selectedShipKind: shipKind,
  });
}

// `DEFAULT_SHIP_KIND` is referenced via `selectedShipKind`'s initial value
// already; this re-export lets callers reset to the default without a deep
// import path.
export { DEFAULT_SHIP_KIND };
export type { WeaponId };
