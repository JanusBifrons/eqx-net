import { create } from 'zustand';
import { loadSettings, saveSettings } from '../settings/settingsStorage.js';
import { loadShipKind, saveShipKind } from '../settings/shipSelectionStorage.js';
import type { UserId } from '../settings/userPrefs.js';
import { DEFAULT_SHIP_KIND } from '../../shared-types/shipKinds.js';
import { type WeaponId } from '../../core/combat/WeaponCatalogue.js';
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
const initialAutoFire      = initialPersisted.autoFireEnabled  ?? true;
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
    | 'autoFireEnabled'
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
    autoFireEnabled: state.autoFireEnabled,
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
 *
 * Plan: crispy-kazoo Commit 1 — extends the reset to also cover the new
 * spawn-handshake fields (`clientReadySent`, `arrivalTickFromServer`,
 * `arrivalAcked`, `localPoseResolved`, `maxProgressSeen`). These are
 * the "no arrival yet" defaults — every new join must re-handshake.
 */
function commonReadinessRearm(prevGen: number): {
  firstSnapshotApplied: false;
  joinMinimumElapsed: false;
  joinGeneration: number;
  clientReadySent: false;
  arrivalTickFromServer: null;
  arrivalAcked: false;
  localPoseResolved: false;
  maxProgressSeen: 0;
} {
  return {
    firstSnapshotApplied: false,
    joinMinimumElapsed: false,
    joinGeneration: prevGen + 1,
    clientReadySent: false,
    arrivalTickFromServer: null,
    arrivalAcked: false,
    localPoseResolved: false,
    maxProgressSeen: 0,
  };
}

export const useUIStore = create<UIStore>((set, get) => ({
  connectionStatus: 'disconnected',
  sectorName: '',
  hullPct: 100,
  shieldPct: 100,
  ammo: 20,
  sectorAlert: null,
  warpWarnings: [],
  playerId: null,
  showDevOverlay: initialDevOverlay,
  showLogPanel: initialLogPanel,
  showServerGhost: initialServerGhost,
  autoFireEnabled: initialAutoFire,
  selectedShipKind: initialShipKind,
  shipCount: 0,
  swarmCount: 0,
  clockRate: 1.0,
  serverTickHz: 60,
  devData: { rtt: 0, drift: 0, angleDrift: 0, lerping: false, snapshotIntervalMs: 0, ticksAhead: 0, snapshotCount: 0, significantCorrectionCount: 0, significantAngleCorrectionCount: 0, maxDriftUnits: 0, maxAngleDriftRad: 0, ackedTick: 0, inputTick: 0, serverTick: 0, serverX: 0, serverY: 0, beforeX: 0, beforeY: 0, afterX: 0, afterY: 0 },
  healthStats: { serverGc: { count30s: 0, maxMs30s: 0 }, longtask: { count30s: 0, maxMs30s: 0 } },
  correctionRate: 0,
  isDead: false,
  currentSectorKey: null,
  transitState: 'DOCKED',
  transitProgress: 0,
  transitTargetSectorKey: null,
  transitSpoolMs: null,
  activeSlotId: 'primary',
  placementKind: null,
  selectedEntityId: null,
  selectedEntityKind: null,
  energyMax: 100,
  lastFireMs: null,
  isDrawerOpen: false,
  drawerTab: 'galaxy',
  // Living Galaxy P5 — the live galaxy map is the first screen on load. The
  // `?room=`/`?galaxy=` deep-links still override to 'game' via App's autoJoin
  // effect; `meta` is retired from the default path (kept reachable via
  // Return-to-menu / Logout).
  phase: 'galaxy-map',
  pendingPickSector: null,
  isGalaxyMapOpen: false,
  galaxyStats: [],
  galaxyStatsLoaded: false,
  galaxyOwnedStructures: [],
  galaxyHover: null,
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
  // ── Spawn handshake (plan: crispy-kazoo Commit 1) ─────────────────
  clientReadySent: false,
  arrivalTickFromServer: null,
  arrivalAcked: false,
  localPoseResolved: false,
  maxProgressSeen: 0,
  loadingCosmeticOnly: false,
  sectorReentryInFlight: false,

  setConnectionStatus: (s) => set({ connectionStatus: s }),
  setSectorName: (name) => set({ sectorName: name }),
  setHullPct: (pct) => set({ hullPct: pct }),
  setShieldPct: (pct) => set({ shieldPct: pct }),
  setAmmo: (ammo) => set({ ammo }),
  setSectorAlert: (msg) => set({ sectorAlert: msg }),
  addWarpWarning: (w) =>
    set((s) => ({
      warpWarnings: [
        ...s.warpWarnings.filter((e) => e.id !== w.id),
        {
          ...w,
          // R2.21 — default to 'hostile' (every live producer is a drone wave);
          // a future friendly/neutral producer passes its own relation.
          relation: w.relation ?? 'hostile',
          observedAtMs: (globalThis.performance ?? Date).now(),
        },
      ],
    })),
  removeWarpWarning: (id) =>
    set((s) => ({ warpWarnings: s.warpWarnings.filter((e) => e.id !== id) })),
  setPlayerId: (id) => set({ playerId: id }),
  setShowDevOverlay:  (v) => { set({ showDevOverlay:  v }); persistSettings(get()); },
  setShowLogPanel:    (v) => { set({ showLogPanel:    v }); persistSettings(get()); },
  setShowServerGhost: (v) => { set({ showServerGhost: v }); persistSettings(get()); },
  setAutoFireEnabled: (v) => { set({ autoFireEnabled: v }); persistSettings(get()); },
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
  setHealthStats: (s) => set({ healthStats: s }),
  setDead: (dead) => set({ isDead: dead }),
  setCurrentSectorKey: (key) => set({ currentSectorKey: key }),
  setTransitState: (s) => set({ transitState: s }),
  setTransitProgress: (p) => set({ transitProgress: p }),
  setTransitTargetSectorKey: (key) => set({ transitTargetSectorKey: key }),
  setTransitSpoolMs: (ms) => set({ transitSpoolMs: ms }),
  // Switching slot resets the wall-clock cooldown anchor so a fresh slot
  // fires immediately (no carry-over cooldown across slots).
  setActiveSlotId: (id) => set({ activeSlotId: id, lastFireMs: null }),
  setPlacementKind: (k) => set({ placementKind: k }),
  setSelectedEntity: (id, kind) => set({ selectedEntityId: id, selectedEntityKind: kind }),
  setEnergyMax: (max) => set({ energyMax: max }),
  setLastFireMs: (ms) => set({ lastFireMs: ms }),
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
  setPendingPickSector: (key) => set({ pendingPickSector: key }),
  rearmJoinReadiness: () => set((s) => commonReadinessRearm(s.joinGeneration)),
  setGalaxyMapOpen: (v) => set({ isGalaxyMapOpen: v }),
  setGalaxyStats: (stats) => set({ galaxyStats: stats }),
  setGalaxyStatsLoaded: (v) => set({ galaxyStatsLoaded: v }),
  setGalaxyOwnedStructures: (sectors) => set({ galaxyOwnedStructures: sectors }),
  setGalaxyHover: (hover) => set({ galaxyHover: hover }),
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
  // ── Spawn handshake setters (plan: crispy-kazoo Commit 1) ─────────
  setClientReadySent: (v) => set({ clientReadySent: v }),
  setArrivalTickFromServer: (tick) => set({ arrivalTickFromServer: tick }),
  setArrivalAcked: (v) => set({ arrivalAcked: v }),
  setLocalPoseResolved: (v) => set({ localPoseResolved: v }),
  setMaxProgressSeen: (p) => set({ maxProgressSeen: p }),
  setLoadingCosmeticOnly: (v) => set({ loadingCosmeticOnly: v }),
  setSectorReentryInFlight: (v) => set({ sectorReentryInFlight: v }),
}));

/**
 * Pure helper: BOOTSTRAP-ready predicate.
 *
 * Plan: crispy-kazoo, Commit 2 — true when the client has finished
 * its local setup AND should fire `client_ready` to the server:
 *   - `connectionStatus === 'connected'` — WebSocket up.
 *   - `localShipInstanceId !== null` — server welcomed us.
 *   - `firstSnapshotApplied` — first state snapshot has landed.
 *   - `localPoseResolved` — `tryInitPredWorld` succeeded.
 *   - `rendererFirstFrameRendered` — Pixi has painted a frame.
 *   - `joinMinimumElapsed` — the 3-5 s minimum-display floor.
 *
 * This is the bootstrap-only predicate; the FULL game-ready (which
 * gates the curtain) additionally requires the handshake's
 * `clientReadySent` + `arrivalTickFromServer` + `arrivalAcked`. See
 * `computeGameReadyFromState` below.
 */
export function computeBootstrapReadyFromState(
  s: Pick<
    UIStore,
    | 'connectionStatus'
    | 'localShipInstanceId'
    | 'rendererFirstFrameRendered'
    | 'firstSnapshotApplied'
    | 'joinMinimumElapsed'
    | 'localPoseResolved'
  >,
): boolean {
  return (
    s.connectionStatus === 'connected'
    && s.localShipInstanceId !== null
    && s.rendererFirstFrameRendered
    && s.firstSnapshotApplied
    && s.joinMinimumElapsed
    && s.localPoseResolved
  );
}

/**
 * Pure helper: join-render readiness predicate — true when the
 * player can safely see the game canvas AND interact with the
 * world. The curtain (`computeIsLoadingActive`) is up exactly when
 * this is false in the game phase.
 *
 * Plan: crispy-kazoo, Commit 2 — extends the bootstrap predicate
 * with the synchronised warp-in handshake gates:
 *   - `clientReadySent` — bootstrap reported "I'm loaded".
 *   - `arrivalTickFromServer !== null` — server returned an
 *     arrival tick.
 *   - `arrivalAcked` — local clock reached the arrival tick;
 *     curtain drops + warp-in animation fires.
 *
 * Drop the handshake gates from this predicate (or `?loading=cosmetic`
 * the kill switch) to restore the legacy behaviour where the curtain
 * lifts as soon as the bootstrap completes.
 */
export function computeGameReadyFromState(
  s: Pick<
    UIStore,
    | 'connectionStatus'
    | 'localShipInstanceId'
    | 'rendererFirstFrameRendered'
    | 'firstSnapshotApplied'
    | 'joinMinimumElapsed'
    | 'localPoseResolved'
    | 'clientReadySent'
    | 'arrivalTickFromServer'
    | 'arrivalAcked'
  >,
): boolean {
  return (
    computeBootstrapReadyFromState(s)
    && s.clientReadySent
    && s.arrivalTickFromServer !== null
    && s.arrivalAcked
  );
}

/**
 * Join-render readiness selector — true when the player can safely see
 * the game canvas without the partial-mount intermediate states. The
 * WarpScreen overlay is visible exactly when this is `false` (in game
 * phase) and hides when it flips `true`.
 *
 * Delegates to `computeGameReadyFromState`.
 */
export function useGameReady(): boolean {
  return useUIStore(computeGameReadyFromState);
}

/**
 * Pure helper: should the loading curtain be raised right now?
 *
 *   - `loadingCosmeticOnly` kill switch wins above everything → false.
 *   - `phase === 'connecting'` (initial connect, ship swap) → true.
 *   - In game phase but not yet ready → true.
 *   - All other phases (meta / auth / galaxy-map / local) → false.
 *
 * Plan: crispy-kazoo — Commit 4 wires this into the gameRafLoop
 * pause boundary + the App.tsx input/audio gates. Commit 5 wires
 * `useShouldRenderHud` into per-component renders.
 */
export function computeIsLoadingActive(s: UIStore): boolean {
  if (s.loadingCosmeticOnly) return false;
  if (s.phase === 'connecting') return true;
  if (s.phase !== 'game') return false;
  return !computeGameReadyFromState(s);
}

export function useIsLoadingActive(): boolean {
  return useUIStore(computeIsLoadingActive);
}

/** Convenience: HUD components return `null` when this is false. */
export function useShouldRenderHud(): boolean {
  return useUIStore((s) => !computeIsLoadingActive(s));
}

/**
 * Pure helper: progress 0–100 for the warp-screen progress bar.
 *
 * Weights chosen so the bar advances monotonically across the gate
 * sequence. `maxProgressSeen` is the latch — once the bar reaches a
 * given percentage it cannot regress on a transient gate flip.
 *
 * Plan: crispy-kazoo Commit 1 — the new spawn-handshake gates
 * (`localPoseResolved`, `clientReadySent`, `arrivalTickFromServer`,
 * `arrivalAcked`) are wired into the weight table; until Commit 2
 * actually flips them, the raw progress caps at ~65 for the legacy
 * 5-gate path. Existing `WarpScreen` still drives its visual fill
 * from elapsed-ms; `computeWarpProgress` is a parallel source the
 * future progress bar will consume.
 */
export function computeWarpProgress(s: UIStore): number {
  let p = 0;
  if (s.connectionStatus === 'connected') p += 10;
  if (s.localShipInstanceId !== null) p += 15;
  if (s.firstSnapshotApplied) p += 15;
  if (s.localPoseResolved) p += 10;
  if (s.rendererFirstFrameRendered) p += 15;
  if (s.joinMinimumElapsed) p += 10;
  if (s.clientReadySent) p += 10;
  if (s.arrivalTickFromServer !== null) p += 10;
  if (s.arrivalAcked) p += 5;
  return Math.max(s.maxProgressSeen, p);
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
    autoFireEnabled: persisted.autoFireEnabled ?? true,
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
