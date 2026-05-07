import { create } from 'zustand';
import { loadSettings, saveSettings } from '../settings/settingsStorage.js';
import { loadShipKind, saveShipKind } from '../settings/shipSelectionStorage.js';
import type { UserId } from '../settings/userPrefs.js';
import { DEFAULT_SHIP_KIND, type ShipKindId } from '../../shared-types/shipKinds.js';
import { DEFAULT_WEAPON, WEAPON_IDS, type WeaponId } from '../../core/combat/WeaponCatalogue.js';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

/** Phase 8 sub-phase B — client-side mirror of the transit lifecycle. */
export type TransitState = 'DOCKED' | 'SPOOLING' | 'IN_TRANSIT' | 'ARRIVED';

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
  /** Currently selected weapon. UI-only discrete selection — NOT spatial. */
  activeWeapon: WeaponId;

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
  setActiveWeapon: (id: WeaponId) => void;
  cycleWeapon: () => void;
}

// The store is constructed before auth resolves, so we hydrate from the
// anonymous slot first. `applyUserPrefs(userId)` is called from App.tsx once
// `useAuthStore.user` is known and re-reads from the per-user slot. If you
// log in for the first time on a device, the legacy `eqxSettings` global key
// migrates into the per-user slot on that re-read (see `userPrefs.ts`).
const initialPersisted   = loadSettings(null);
const initialShipKind    = loadShipKind(null);
const initialDevOverlay  = initialPersisted.showDevOverlay  ?? true;
const initialLogPanel    = initialPersisted.showLogPanel    ?? true;
const initialServerGhost = initialPersisted.showServerGhost ?? true;

/** Tracks which user the store is currently persisting under, so setters can
 *  target the right `localStorage` slot without each setter taking a userId
 *  argument. Updated by `applyUserPrefs`. */
let activeUserId: UserId = null;

function persistSettings(state: Pick<UIStore, 'showDevOverlay' | 'showLogPanel' | 'showServerGhost'>): void {
  saveSettings(activeUserId, {
    showDevOverlay:  state.showDevOverlay,
    showLogPanel:    state.showLogPanel,
    showServerGhost: state.showServerGhost,
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
  activeWeapon: DEFAULT_WEAPON,

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
  setActiveWeapon: (id) => set({ activeWeapon: id }),
  cycleWeapon: () => set((s) => {
    const idx = WEAPON_IDS.indexOf(s.activeWeapon);
    return { activeWeapon: WEAPON_IDS[(idx + 1) % WEAPON_IDS.length]! };
  }),
}));

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
    selectedShipKind: shipKind,
  });
}

// `DEFAULT_SHIP_KIND` is referenced via `selectedShipKind`'s initial value
// already; this re-export lets callers reset to the default without a deep
// import path.
export { DEFAULT_SHIP_KIND };
export type { WeaponId };
