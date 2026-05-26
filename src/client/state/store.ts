import { create } from 'zustand';
import { loadSettings, saveSettings } from '../settings/settingsStorage.js';
import { loadShipKind, saveShipKind } from '../settings/shipSelectionStorage.js';
import type { UserId } from '../settings/userPrefs.js';
import { DEFAULT_SHIP_KIND } from '../../shared-types/shipKinds.js';
import { DEFAULT_WEAPON, WEAPON_IDS, type WeaponId } from '../../core/combat/WeaponCatalogue.js';
import type {
  ConnectionStatus,
  ServerHealth,
  RosterEntry,
  TransitState,
  Phase,
  DevData,
  UIStore,
} from './storeTypes.js';

// Re-export the type surface so existing import sites (40+ files using
// `import { useUIStore, type Phase } from './state/store'`) keep
// resolving without per-site edits.
export type { ArrivalMode } from '../settings/settingsStorage.js';
export type {
  ConnectionStatus,
  ServerHealth,
  RosterEntry,
  TransitState,
  Phase,
  DevData,
  UIStore,
};

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

/**
 * Shared WarpScreen join-readiness re-arm. Used by BOTH `setPhase`
 * (enter/leave-`game`) and `rearmJoinReadiness` (committed inter-sector
 * transit) so the overlapping flags + the monotone `joinGeneration`
 * bump (which re-runs the App.tsx 5 s minimum-display timer — a pure
 * transit does NOT remount GameSurface, so its `[]`-dep effect would
 * never otherwise re-fire) stay identical between the two paths.
 * `setPhase` additionally clears `rendererFirstFrameRendered` because a
 * phase change remounts GameSurface and the renderer may re-init (real
 * GPU-init lag); a pure inter-sector transit keeps the SAME live
 * renderer, so that flag stays truthfully true there. This is the
 * UI-readiness analogue of `resetPredictionState()` — the one
 * spatial-seed site, invoked by connect + the `transit_ready` handler.
 */
function commonReadinessRearm(prevGen: number): {
  firstSnapshotApplied: false;
  joinMinimumElapsed: false;
  joinGeneration: number;
} {
  return { firstSnapshotApplied: false, joinMinimumElapsed: false, joinGeneration: prevGen + 1 };
}

export const useUIStore = create<UIStore>((set, get) => ({
  connectionStatus: 'disconnected',
  sectorName: '',
  hullPct: 100,
  shieldPct: 100,
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
  joinMinimumElapsed: false,
  joinGeneration: 0,
  serverHealth: 'unknown',
  playersOnline: null,

  setConnectionStatus: (s) => set({ connectionStatus: s }),
  setSectorName: (name) => set({ sectorName: name }),
  setHullPct: (pct) => set({ hullPct: pct }),
  setShieldPct: (pct) => set({ shieldPct: pct }),
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
    // Join-render readiness reset. `setPhase` re-arms on phase
    // ENTER/LEAVE-`game` (initial join, ship-swap arrival, respawn) —
    // GameSurface remounts there and the renderer may re-init, so
    // `rendererFirstFrameRendered` is correctly cleared too. A pure
    // inter-sector transit keeps `phase==='game'` the whole time, so
    // `setPhase` is intentionally a no-op for the flags then; that path
    // is re-armed by `rearmJoinReadiness()` from the `transit_ready`
    // handler instead (the UI-readiness analogue of
    // `resetPredictionState()` — one ownership concept, two
    // domain-correct variants). Both share `commonReadinessRearm` so
    // the overlapping flags + the `joinGeneration` bump stay identical.
    if (p === 'game' && prev.phase !== 'game') {
      return { phase: p, ...commonReadinessRearm(prev.joinGeneration), rendererFirstFrameRendered: false };
    }
    if (p !== 'game' && prev.phase === 'game') {
      return { phase: p, ...commonReadinessRearm(prev.joinGeneration), rendererFirstFrameRendered: false };
    }
    return { phase: p };
  }),
  rearmJoinReadiness: () => set((s) => commonReadinessRearm(s.joinGeneration)),
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
  setJoinMinimumElapsed: (v) => set({ joinMinimumElapsed: v }),
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
 * Composed from four sub-flags — ALL must be true:
 *   - `connectionStatus === 'connected'` — WebSocket up.
 *   - `localShipInstanceId !== null` — server welcomed us; we have an
 *     identity to render.
 *   - `rendererFirstFrameRendered` — Pixi has painted a frame with the
 *     LOCAL player's mirror entry visible.
 *   - `joinMinimumElapsed` — the 5-second minimum-display floor (set
 *     by GameSurface's mount-time setTimeout) has elapsed. Reconciler
 *     has had time to apply its first correction before the player
 *     sees the canvas, so the first-move teleport (user-reported
 *     2026-05-14: "the first time you move. It teleports you to where
 *     you actually are") is absorbed under the warp visual.
 *
 * `setPhase` resets the readiness flags on every entry into game
 * phase so subsequent room transitions retrigger the overlay.
 */
export function useGameReady(): boolean {
  return useUIStore(
    (s) =>
      s.connectionStatus === 'connected'
      && s.localShipInstanceId !== null
      && s.rendererFirstFrameRendered
      && s.firstSnapshotApplied
      && s.joinMinimumElapsed,
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
