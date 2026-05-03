import { create } from 'zustand';
import { loadSettings, saveSettings } from '../settings/settingsStorage.js';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

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
  devData: DevData;
  /** Fraction 0–1 of snapshots that triggered a significant correction. Always-visible HUD stat. */
  correctionRate: number;
  /** True when the local ship has been destroyed and is awaiting respawn. */
  isDead: boolean;

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
  setDevData: (d: DevData) => void;
  setDead: (dead: boolean) => void;
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
  devData: { rtt: 0, drift: 0, angleDrift: 0, lerping: false, snapshotIntervalMs: 0, ticksAhead: 0, snapshotCount: 0, significantCorrectionCount: 0, significantAngleCorrectionCount: 0, maxDriftUnits: 0, maxAngleDriftRad: 0, ackedTick: 0, inputTick: 0, serverTick: 0, serverX: 0, serverY: 0, beforeX: 0, beforeY: 0, afterX: 0, afterY: 0 },
  correctionRate: 0,
  isDead: false,

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
  setDevData: (d) => set({
    devData: d,
    correctionRate: d.snapshotCount > 0 ? d.significantCorrectionCount / d.snapshotCount : 0,
  }),
  setDead: (dead) => set({ isDead: dead }),
}));
