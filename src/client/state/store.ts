import { create } from 'zustand';
import { loadSettings, saveSettings } from '../settings/settingsStorage.js';

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

  setConnectionStatus: (s: ConnectionStatus) => void;
  setSectorName: (name: string) => void;
  setHullPct: (pct: number) => void;
  setAmmo: (ammo: number) => void;
  setSectorAlert: (msg: string | null) => void;
  setPlayerId: (id: string) => void;
  setShowDevOverlay: (v: boolean) => void;
  setShowLogPanel: (v: boolean) => void;
  setShowServerGhost: (v: boolean) => void;
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
}

const persisted = loadSettings();
// Defaults preserve existing in-game appearance — every debug overlay was
// always-on before this screen existed, so first-time visitors keep the same
// experience until they opt out.
const initialDevOverlay  = persisted.showDevOverlay  ?? true;
const initialLogPanel    = persisted.showLogPanel    ?? true;
const initialServerGhost = persisted.showServerGhost ?? true;

function persist(state: Pick<UIStore, 'showDevOverlay' | 'showLogPanel' | 'showServerGhost'>): void {
  saveSettings({
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

  setConnectionStatus: (s) => set({ connectionStatus: s }),
  setSectorName: (name) => set({ sectorName: name }),
  setHullPct: (pct) => set({ hullPct: pct }),
  setAmmo: (ammo) => set({ ammo }),
  setSectorAlert: (msg) => set({ sectorAlert: msg }),
  setPlayerId: (id) => set({ playerId: id }),
  setShowDevOverlay:  (v) => { set({ showDevOverlay:  v }); persist(get()); },
  setShowLogPanel:    (v) => { set({ showLogPanel:    v }); persist(get()); },
  setShowServerGhost: (v) => { set({ showServerGhost: v }); persist(get()); },
  toggleDevOverlay: () => { set((s) => ({ showDevOverlay: !s.showDevOverlay })); persist(get()); },
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
}));
