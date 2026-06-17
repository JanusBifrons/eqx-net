import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { installWindowLogger } from './debug/ClientLogger';
import { installStreamingDiag } from './debug/streamingDiag';
import { installTestLeakHook } from './debug/testLeakHook';
import { Box } from '@mui/material';
import { ColyseusGameClient } from './net/ColyseusClient';
import { setGameClient } from './net/clientSingleton';
import { HowlerAudioService } from './audio/HowlerAudioService';
import { selectRenderer, installProfileWindow } from './app/gameSurfaceBootstrap';
import { runGameSurfaceConnectFlow } from './app/gameSurfaceConnectFlow';
import {
  useServerHealthPoll,
  useShipSwapDispatcher,
  usePhaseChangeLog,
  useAuthExpiryRedirect,
  useUserPrefsHydration,
} from './app/appHooks';
import { PhaseRouter } from './app/PhaseRouter';
import {
  syncGalaxyVisibility,
  syncGalaxyCurrentSector,
  syncGalaxyTransitDocked,
  syncGalaxyStats,
  syncGalaxyPresence,
} from './app/galaxyOverlay';
import type { IRenderer } from '@core/contracts/IRenderer';
import { GalaxyMapLayer } from './render/galaxy/GalaxyMapLayer';
import { useGalaxyStats } from './app/useGalaxyStats';
import { useGalaxyPresence } from './app/useGalaxyPresence';
import { mergePlayerPresence } from './app/galaxyPresence';
import { loadStoredPlayerId } from './identity/token';
import { Keyboard } from './input/Keyboard';
import { TouchInput, isTouchDevice } from './input/TouchInput';
import { useUIStore, useGameReady, useIsLoadingActive } from './state/store';
import { useAuthStore } from './auth/authStore';
import { decideContextMenuPlacement } from './structures/contextMenuPlacement';
import { MobileControls } from './components/MobileControls';
import { AutoFireToggleButton } from './components/AutoFireToggleButton';
import { ErrorBoundary } from './components/ErrorOverlay';
import { HyperspaceOverlay } from './components/HyperspaceOverlay';
import { WarpScreen } from './components/WarpScreen';
import { LostConnectionOverlay } from './components/LostConnectionOverlay';
import { DeathOverlay } from './components/DeathOverlay';
import { engageTransit, cancelTransit } from './net/transitClient';
import { logEvent } from './debug/ClientLogger';
import { captureDeviceInfo } from './debug/deviceInfo';
import { useMountLog } from './debug/useMountLog';
import { useWarpOrchestration } from './useWarpOrchestration';
import { ShipStatsCard } from './components/ShipStatsCard';
import { EnergyBar } from './components/EnergyBar';
import { SpeedDialMenu } from './components/SpeedDialMenu';
import { StructurePlacementBanner } from './components/StructurePlacementBanner';
import { GridPowerReadout } from './components/GridPowerReadout';
import { EntityStatsPanel } from './components/EntityStatsPanel';
import { Hud } from './components/Hud';
import { SectorInfoPanel } from './components/SectorInfoPanel';
import { HudTestAttributes } from './components/HudTestAttributes';
import { ShieldHullBar } from './components/ShieldHullBar';
import { WarpInWarningBanner } from './components/WarpInWarningBanner';
import { GalaxyPickerChrome, type GalaxyPickerApi } from './components/GalaxyPickerChrome';
import { GalaxyOverviewSelectChrome } from './components/GalaxyOverviewSelectChrome';
import { LayoutProvider } from './layout/LayoutProvider';
import { Slot } from './layout/Slot';
import { AdvancedDrawer } from './layout/Drawer/AdvancedDrawer';
import { TopRightToolbar } from './layout/TopRightToolbar';

// Install window.__eqxLogs and window.__eqxClearLogs at module load time.
installWindowLogger();

// Probe 2 — device fingerprint + native rAF cadence calibration. Fires
// before any game work starts so the measurement is uncontaminated. See
// `debug/deviceInfo.ts` for the captured fields. Critical for the
// mobile-perf-investigation: tells us if a 45 fps cadence is a real
// 45 Hz panel or a Chrome software throttle on a 60/90 Hz panel.
captureDeviceInfo();
// Streaming auto-capture mode — no-op unless `?autocapture=1`. Plan:
// streaming auto-capture, Phase 0 stub (2026-05-21). Installs from the
// same module-top-level site as installWindowLogger so streaming
// captures pre-game events (auth / galaxy map / ship picker), not just
// post-join state.
installStreamingDiag();
// Mobile-perf gate regression-lock support — installs a RAF allocator
// only when `?injectLeak=N` is present AND the build is DEV (Vite
// tree-shakes the call site in prod). See `debug/testLeakHook.ts` +
// `tests/mobile-perf/heap-budget-injected-leak.spec.ts`.
installTestLeakHook();

/** Delay between a galaxy sector tap and the kind-picker mount, in ms.
 *  The tap originates on the shared Pixi canvas, so the originating
 *  touchend can bleed through onto the modal mounted under the player's
 *  finger and auto-resolve a card. Deferring the picker mount past the
 *  touchend drain (≈50 ms ceiling on slow phones) avoids that. Moved
 *  here from the retired GalaxyOverviewScreen with the single-canvas
 *  refactor — the tap-shield belongs at the tap site. */
const PICKER_OPEN_DELAY_MS = 200;
// Living Galaxy P5 — after an auth-gated pick (logged-out → auth → success)
// the post-auth effect returns to 'galaxy-map' and re-opens the picker for the
// stashed sector. The map remounts on the phase switch, so wait a beat for
// GalaxyPickerChrome to re-register its apiRef, then retry briefly.
const POST_AUTH_PICKER_OPEN_DELAY_MS = 200;

interface GameSurfaceProps {
  /**
   * `connect` — the gameplay surface: connect to a Colyseus room, render
   * the HUD. `idle` — the persistent galaxy-picker canvas (single-canvas
   * refactor): the same shared canvas renders the hex map via
   * GalaxyMapLayer in selector mode, with GalaxyPickerChrome overlaid; no
   * room is joined. The flip to `connect` happens when a sector is chosen.
   */
  surfaceMode: 'idle' | 'connect';
  /** Phase 8 — room name chosen by the lobby/galaxy-map screen. Falls back
   *  to the URL `?room=` / `?galaxy=` params or `'sector'` when undefined,
   *  preserving the E2E auto-join escape hatch. */
  roomNameOverride?: string;
  /** Phase 3 multi-ship roster — extra join options forwarded to the
   *  Colyseus `joinOrCreate` call. Used by the roster-panel Spawn flow
   *  to thread the chosen `shipId` to the server's `onJoin`. */
  joinOptionsOverride?: Record<string, unknown>;
  /** Idle (galaxy-picker) spawn entry points. */
  onSelectRoom?: (roomName: string) => void;
  onSpawnExistingShip?: (shipId: string, sectorKey: string) => void;
  onSpawnNewShip?: (kind: unknown, sectorKey: string) => void;
  onSelectLocal?: () => void;
}

function GameSurface({
  surfaceMode,
  roomNameOverride,
  joinOptionsOverride,
  onSelectRoom,
  onSpawnExistingShip,
  onSpawnNewShip,
  onSelectLocal,
}: GameSurfaceProps): JSX.Element {
  const idle = surfaceMode === 'idle';
  // Equinox Phase 7 (Item 1) — ONE map: both the landing picker and the in-game
  // warp map use the full-page `selector` layer (the translucent `overlay` is
  // retired). In-game it auto-frames the current sector + neighbours (keyed on
  // currentSectorKey) and routes taps to the popover; visibility is the Map
  // toggle (`isGalaxyMapOpen`), wired separately by syncGalaxyVisibility.
  const overlayMode = 'selector' as const;
  // Imperative handle into the picker chrome so a sector tap on the
  // shared canvas's selector layer opens the kind-picker.
  const pickerApiRef = useRef<GalaxyPickerApi | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<ColyseusGameClient | null>(null);
  const rendererRef = useRef<IRenderer | null>(null);
  const galaxyLayerRef = useRef<GalaxyMapLayer | null>(null);
  const keyboardRef = useRef<Keyboard | null>(null);
  const animFrameRef = useRef<number>(0);
  const isTouchRef = useRef<boolean>(isTouchDevice());
  const touchInputRef = useRef<TouchInput | null>(
    isTouchRef.current ? new TouchInput() : null,
  );
  // Plan: crispy-kazoo, Commit 4 — pause boundary needs audio handle
  // for suspendAll / resumeAll on loading transitions.
  const audioRef = useRef<HowlerAudioService | null>(null);
  // Join-render diagnostic anchor — captured once per GameSurface mount.
  // Used by the `join_chain_complete` event below + by the rAF loop's
  // `pixi_first_frame` payload.
  const gameSurfaceMountedAtRef = useRef<number>(performance.now());
  const joinChainCompleteLoggedRef = useRef<boolean>(false);
  const gameReady = useGameReady();
  // Plan: crispy-kazoo, Commit 4 — pause boundary: gate audio + input
  // off the curtain visibility (`useIsLoadingActive`). Honours the
  // `?loading=cosmetic` URL kill switch via the underlying selector.
  const isLoadingActive = useIsLoadingActive();
  // Per-setter selectors, NOT a no-arg `useUIStore()` whole-store subscription.
  // A no-arg subscription re-renders GameSurface — the entire HUD subtree
  // (every Slot, SpeedDialMenu, the MUI bars/panels) — on EVERY store write,
  // including per-hit shield/hull + swarm-count churn during combat. That
  // cascaded an Emotion style-reserialization storm that pegged the main
  // thread (~75% busy, render dropping to ~30Hz) — the on-device "lag"
  // (CPU profile 2026-06-06: ~44% React+MUI+Emotion vs ~9% Pixi). Setters are
  // stable refs, so selecting each one never triggers a re-render.
  const setConnectionStatus = useUIStore((s) => s.setConnectionStatus);
  const setPlayerId = useUIStore((s) => s.setPlayerId);
  const setSectorName = useUIStore((s) => s.setSectorName);

  // Plan: crispy-kazoo, Commit 4 — on loading transitions, suspend the
  // audio context + disable Keyboard / TouchInput so input events the
  // user fires "during the curtain" don't reach the server. Held keys
  // are zeroed on disable so a key still held at the moment the
  // curtain drops doesn't auto-thrust on resume — the user must
  // re-press to act.
  useEffect(() => {
    const audio = audioRef.current;
    const keyboard = keyboardRef.current;
    const touch = touchInputRef.current;
    if (isLoadingActive) {
      audio?.suspendAll();
      keyboard?.setEnabled(false);
      touch?.setEnabled(false);
    } else {
      audio?.resumeAll();
      keyboard?.setEnabled(true);
      touch?.setEnabled(true);
    }
  }, [isLoadingActive]);

  // Fire `join_chain_complete` exactly once per GameSurface mount, when
  // all four readiness gates (connected + welcomed + first-snapshot OR
  // timeout + first-frame-rendered) have flipped true. Pairs with
  // `pixi_first_frame` and `local_pose_resolved` so the diagnostic
  // capture has both the per-gate events AND a single summary event
  // with total elapsed time.
  useEffect(() => {
    if (gameReady && !joinChainCompleteLoggedRef.current) {
      joinChainCompleteLoggedRef.current = true;
      const msFromPhaseEnter = Math.round(performance.now() - gameSurfaceMountedAtRef.current);
      logEvent('join_chain_complete', {
        msFromPhaseEnter,
      });
      // Plan: crispy-kazoo, Commit 3 — terminal "ready, curtain dropped"
      // event for the death→respawn lifecycle. The earlier
      // `local_died` / `respawn_clicked` / `respawn_first_snapshot` /
      // `client_ready_sent` / `arrival_acked` events form the chain;
      // this is the closing marker. `msFromClicked` is derived against
      // the most-recent diedAtMs (clientRef may be null in non-game
      // phases, so the field is omitted in that branch).
      const client = clientRef.current;
      const msFromDied = client && client.diedAtMs > 0
        ? Math.round(performance.now() - client.diedAtMs)
        : null;
      logEvent('respawn_ready', { msFromPhaseEnter, msFromDied });
    }
  }, [gameReady]);

  // Minimum-display-time floor for the WarpScreen. Plan crispy-kazoo
  // Commit 9 — lowered from 5 s to 2.5 s. The reconciler's first
  // correction-apply window is what the floor protected (the
  // 2026-05-14 311-unit pre-curtain-drop drift). Post-handshake the
  // first correction lands during the curtain phase too (server's
  // 5-s join-broadcast grace pushes snapshots immediately), so 2.5 s
  // is comfortable margin — and 2.5 s + the 600 ms arrival-handshake
  // budget puts total click-to-playable around ~3-3.5 s, which is the
  // shortest the user's "natural pause" request tolerates.
  //
  // Keyed on `joinGeneration` (Phase G): a pure inter-sector transit
  // keeps `phase==='game'` so GameSurface does NOT remount — a
  // mount-scoped `[]` effect would arm the floor exactly once per
  // session and never again, so the 2nd+ transit had no floor and the
  // WarpScreen never re-showed. `rearmJoinReadiness()` (from the
  // `transit_ready` handler) bumps `joinGeneration`; the dep change
  // tears down the stale timer (cleanup) and re-runs a fresh floor.
  const joinGeneration = useUIStore((s) => s.joinGeneration);
  useEffect(() => {
    const timer = setTimeout(() => {
      useUIStore.getState().setJoinMinimumElapsed(true);
    }, 2500);
    return () => clearTimeout(timer);
  }, [joinGeneration]);

  // ── Warp visual orchestration ─────────────────────────────────────
  // Load curtain + spool→climax+burst envelope + single arrival flash.
  // Extracted to `useWarpOrchestration` (behaviour-identical to the
  // prior inline effects) so the call-ordering invariant — curtain up
  // before the spool-exit burst → a single arrival flash (Phase G) —
  // is unit-lockable. See `App.warpOrchestration.test.tsx`.
  useWarpOrchestration(rendererRef);

  // Phase 5 scope change — when the player dies and clicks Respawn, send
  // them BACK TO THE GALAXY MAP rather than respawning in-place. The
  // post-auth landing screen is now the canonical "pick where to spawn"
  // surface (it shows roster + sector picker), so re-using it for
  // post-death respawn is consistent UX. The in-place `respawnShip` RPC
  // is preserved on `ColyseusGameClient` for tests / engineering rooms
  // but the user-facing UI no longer calls it.
  //
  // Phase changes from 'game' → 'galaxy-map' unmount `GameSurface`,
  // which cleans up the room. The roster panel on the landing screen
  // reflects the loss (the dead ship's roster row is destroyed, so it
  // disappears).
  //
  // We also clear every transient in-game overlay flag (galaxy map open,
  // overview open, drawer open, pending swap) so a player who died with
  // any of those mounted doesn't see them re-appear on their next spawn.
  // This is the edge case captured 2026-05-13: die-while-galaxy-overview-
  // open left `isGalaxyOverviewOpen=true` in the store; the next spawn
  // saw the overview pop back open immediately on top of the fresh game.
  const handleRespawn = useCallback(() => {
    // Plan: crispy-kazoo, Commit 3 — log the respawn click so the
    // diag-capture timeline names WHICH path triggered the cycle.
    // 'button' = in-game Respawn button (this handler); the
    // 'sector-pick' counterpart logs from GalaxyOverviewScreen on
    // the spawn-mode sector tap. Both lead to the galaxy-map phase
    // + leave-room + rejoin flow (per the user's "same flow" decision).
    const client = clientRef.current;
    const msFromDied = client && client.diedAtMs > 0
      ? Math.round(performance.now() - client.diedAtMs)
      : -1;
    logEvent('respawn_clicked', { source: 'button', msFromDied });

    const ui = useUIStore.getState();
    ui.setLocalShipInstanceId(null);
    ui.setCurrentSectorKey(null);
    ui.setDead(false);
    ui.setGalaxyOverviewOpen(false);
    ui.setGalaxyMapOpen(false);
    ui.setDrawerOpen(false);
    ui.setPendingShipSwap(null);
    ui.setPhase('galaxy-map');
  }, []);

  const getLocalShip = useCallback(() => {
    const c = clientRef.current;
    if (!c) return null;
    const id = c.mirror.localPlayerId;
    if (!id) return null;
    return c.mirror.ships.get(id) ?? null;
  }, []);

  // Phase 2 — galaxy-map open state lives in Zustand so the drawer's Galaxy
  // tab can open the overlay without prop drilling. The keyboard `M`
  // shortcut continues to toggle it from this component.
  // Galaxy-map (additive) open state lives in Zustand so the drawer's
  // Galaxy tab can drive it. The keyboard `M` shortcut also toggles it
  // from inside this component. The bool is read for the conditional
  // `<GalaxyMapOverlay>` render; setGalaxyMapOpen has been moved
  // closer to its single callsite (the Pixi layer's onSelect callback,
  // which uses `useUIStore.getState()` to avoid a closure over a stale
  // setter), so it isn't a hook here anymore.
  const galaxyMapOpen        = useUIStore((s) => s.isGalaxyMapOpen);
  const toggleGalaxyMap      = useUIStore((s) => s.toggleGalaxyMapOpen);
  const galaxyOverviewOpen   = useUIStore((s) => s.isGalaxyOverviewOpen);
  const setGalaxyOverviewOpen = useUIStore((s) => s.setGalaxyOverviewOpen);

  const handleEngageTransit = useCallback((targetSectorKey: string) => {
    const room = clientRef.current?.getRoom();
    if (!room) return;
    // F-transit-instrument — t0 for the transit timeline. The user's
    // "warp-out" == opening the in-game galaxy MAP and tapping a
    // neighbour, which routes here. Gated/no-op unless ?diag=1 /
    // WebDriver. Lives on the client so it survives the room
    // hot-swap (see TransitInstrumentation).
    clientRef.current?.transitInstr.engage({ target: targetSectorKey });
    // Pull the current arrival picker state (mobile-only UI; PC keeps the
    // default `'same'` mode and sends no `arrival`, preserving legacy
    // behaviour). The xy values were already clamped on blur in GalaxyTab,
    // and the server clamps again as defense-in-depth.
    const s = useUIStore.getState();
    let arrival: { x: number; y: number } | undefined;
    if (s.arrivalMode === 'xy') {
      arrival = { x: s.arrivalTargetX, y: s.arrivalTargetY };
    } else if (s.arrivalMode === 'home') {
      arrival = { x: s.homePosX, y: s.homePosY };
    }
    engageTransit(room, targetSectorKey, arrival);
  }, []);
  const handleCancelTransit = useCallback(() => {
    const room = clientRef.current?.getRoom();
    if (room) cancelTransit(room);
  }, []);

  // Selector-mode tap (idle galaxy picker). A hex tap on the shared
  // canvas routes here; we log the same diagnostics the retired
  // GalaxyOverviewScreen emitted (galaxy_sector_click + respawn_clicked
  // source='sector-pick'), then defer the kind-picker mount past the
  // touchend drain (tap-shield) and open it via the chrome's apiRef.
  const handleSelectorPick = useCallback((sectorKey: string) => {
    const t0 = performance.now();
    logEvent('galaxy_sector_click', { key: sectorKey, mode: 'spawn', ts: t0 });
    logEvent('respawn_clicked', { source: 'sector-pick', sectorKey });
    // Living Galaxy P5 — auth-gate on PICK. The galaxy map is the logged-out
    // landing screen (fully interactive), but spawning requires a login: stash
    // the picked sector and route to the auth flow. On return, the remounted
    // GameSurface re-opens this sector's picker (see the idle-mount effect
    // below). A non-reactive getState() read keeps the callback stable.
    // Auth-gate the spawn ONLY on the landing map (phase 'galaxy-map'). In-game
    // (Equinox Phase 7 warp map, phase 'game') the pilot is already in a room —
    // never bounce them to the auth flow.
    if (useUIStore.getState().phase === 'galaxy-map' && !useAuthStore.getState().user) {
      logEvent('pick_auth_gate', { sectorKey });
      useUIStore.getState().setPendingPickSector(sectorKey);
      useUIStore.getState().setPhase('auth');
      return;
    }
    window.setTimeout(() => {
      pickerApiRef.current?.openForSector(sectorKey);
    }, PICKER_OPEN_DELAY_MS);
  }, []);

  // Equinox Phase 9 — selector-mode BLUR: a confirmed tap that hit no hex
  // (empty space) deselects the sector + closes the SectorInfoDrawer ("making a
  // selection which isn't a sector should deselect"). Routed from the galaxy
  // layer through the same tap channel as the pick (null sectorKey).
  const handleSelectorDeselect = useCallback(() => {
    pickerApiRef.current?.deselect();
  }, []);

  // Living Galaxy P5 — returning from the auth detour after an auth-gated pick:
  // re-open the picker for the stashed sector. The map remounts on the
  // auth→galaxy-map switch, so retry briefly until GalaxyPickerChrome has
  // re-registered its apiRef. Only meaningful in idle (selector) mode; the
  // very first landing has no stashed sector and no-ops.
  useEffect(() => {
    if (!idle) return;
    if (!useUIStore.getState().pendingPickSector) return;
    let cancelled = false;
    let attempts = 0;
    // Clear the stash ONLY on a successful open (not at effect start): React
    // StrictMode double-invokes effects in dev, and clearing up-front let the
    // first invocation's cleanup cancel the open while the second saw an
    // already-cleared stash and never re-opened. Reading + clearing inside the
    // retry makes it idempotent across the double-invoke.
    const tryOpen = (): void => {
      if (cancelled) return;
      const pending = useUIStore.getState().pendingPickSector;
      if (!pending) return; // already consumed
      if (pickerApiRef.current) {
        useUIStore.getState().setPendingPickSector(null);
        pickerApiRef.current.openForSector(pending);
        return;
      }
      if (++attempts < 40) window.setTimeout(tryOpen, 50);
    };
    window.setTimeout(tryOpen, POST_AUTH_PICKER_OPEN_DELAY_MS);
    return () => { cancelled = true; };
  }, [idle]);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    let disposed = false;

    const keyboard = new Keyboard();
    keyboardRef.current = keyboard;

    // Renderer-path selection + profile-window opt-in. Extracted to
    // gameSurfaceBootstrap.ts — full rationale lives there.
    const { renderer, useWorker } = selectRenderer();
    rendererRef.current = renderer;
    installProfileWindow();

    const gameClient = new ColyseusGameClient();
    const audio = new HowlerAudioService();
    audioRef.current = audio;
    gameClient.setAudio(audio);
    clientRef.current = gameClient;
    // Module-level singleton so low-cadence React reads (e.g. the Galaxy
    // tab's 5 s arrival-snapshot poll) can reach `mirror` without prop
    // drilling. See `src/client/net/clientSingleton.ts`.
    setGameClient(gameClient);
    // Expose for the dev-only diagnostic capture (SettingsModal "Capture" button
    // reads `__eqxClient.stats`). DEV-only assignment guarded by Vite's tree-shaking.
    if (import.meta.env.DEV) {
      (window as unknown as { __eqxClient?: ColyseusGameClient }).__eqxClient = gameClient;
      // Test-only hook for E2E specs: set the active weapon SLOT directly
      // (weapons/energy/AI overhaul §5.2 — the per-weapon picker is gone;
      // each ship fires its catalogue-bound loadout). Production tree-shakes.
      (window as unknown as { __eqxSetActiveSlot?: (id: string) => void })
        .__eqxSetActiveSlot = (id: string) => {
          useUIStore.getState().setActiveSlotId(id);
        };
      // Test-only hook for the respawn-cascade E2E spec
      // (`respawn-cascade-input-routing.spec.ts`). Drives a
      // game → connecting → game phase cycle that unmounts GameSurface
      // (running the dispose cleanup we just instrumented) and remounts
      // it with a fresh ColyseusGameClient. This is the SAME cascade
      // a galaxy-map sector-pick triggers, but reachable from a
      // Playwright test without clicking the Pixi-rendered map.
      // Production tree-shakes.
      (window as unknown as { __eqxTriggerRespawnCascade?: () => void })
        .__eqxTriggerRespawnCascade = () => {
          const ui = useUIStore.getState();
          ui.setPhase('connecting');
          setTimeout(() => useUIStore.getState().setPhase('game'), 100);
        };
      // Test-only hook: drive a galaxy sector pick deterministically from
      // E2E without computing the hex's on-screen pixel position. Mirrors
      // a real selector-layer tap (single-canvas refactor). Only meaningful
      // in idle mode; production tree-shakes.
      (window as unknown as { __eqxGalaxyPick?: (key: string) => void })
        .__eqxGalaxyPick = (key: string) => handleSelectorPick(key);
      // Living Galaxy P5 — set a logged-in auth user deterministically so E2E
      // can exercise the logged-IN pick path (straight to the picker, no auth
      // detour) without real credentials. Production tree-shakes.
      (window as unknown as { __eqxSetAuthUser?: (name?: string) => void })
        .__eqxSetAuthUser = (name?: string) => {
          useAuthStore.getState().setAuth('e2e-token', {
            id: 'e2e-user',
            email: 'e2e@example.test',
            displayName: name ?? 'E2E Pilot',
          });
        };
    }

    const onKey = (e: KeyboardEvent): void => {
      // Phase 8 sub-phase B — toggle the in-game galaxy-map overlay. 'M' is
      // unmodified so it's reachable on a keyboard during play; the overlay
      // disables itself if `transitState !== 'DOCKED'`.
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'm' || e.key === 'M')) {
        toggleGalaxyMap();
      }
      // WS-10 (R2.5) — Escape cancels structure placement. Main-thread + window
      // level so it works on BOTH render paths (the renderer can't touch
      // Zustand). No-op when not placing.
      if (e.key === 'Escape' && useUIStore.getState().placementKind) {
        useUIStore.getState().setPlacementKind(null);
      }
    };
    window.addEventListener('keydown', onKey);

    // WS-10 (R2.5) — right-click cancels structure placement (and suppresses the
    // browser context menu while placing). Window-level so it catches the
    // right-click on the gameplay canvas regardless of which thread renders it
    // (the canvas DOM element + its events live on the main thread on both
    // paths). Outside placement we leave the native menu alone.
    //
    // P6.2 (Equinox Phase 6) — Android fires `contextmenu` on a touch LONG-PRESS
    // too, so an unconditional cancel here meant a hold-to-position during
    // placement CANCELLED it (+ the OS long-press haptic — "vibrates then
    // doesn't place"). Track the last pointerdown's `pointerType` and only
    // CANCEL on a mouse right-click; still `preventDefault` the native menu on
    // both. Per-gesture (not `isTouchDevice()`), so a mouse on a hybrid
    // touchscreen still right-click-cancels.
    let lastPointerType = '';
    const onPointerDownType = (e: PointerEvent): void => { lastPointerType = e.pointerType; };
    window.addEventListener('pointerdown', onPointerDownType, { capture: true });
    const onContextMenu = (e: MouseEvent): void => {
      const s = useUIStore.getState();
      // Equinox Phase 7 (Item 4) — the galaxy map (landing phase OR the in-game
      // map toggle) never wants a browser context menu; suppress it so a mobile
      // long-press on the map doesn't pop the OS menu.
      const galaxyMapOpen = s.isGalaxyMapOpen || s.phase === 'galaxy-map';
      const outcome = decideContextMenuPlacement(
        s.placementKind !== null,
        lastPointerType,
        galaxyMapOpen,
      );
      if (outcome.preventDefault) e.preventDefault();
      if (outcome.cancel) useUIStore.getState().setPlacementKind(null);
    };
    window.addEventListener('contextmenu', onContextMenu);

    // Anchor for the join-render diagnostics (see `pixi_first_frame` /
    // `local_pose_resolved` / `join_chain_complete` events). The
    // `phaseEnterPerfNow` is captured BEFORE the async `renderer.init`
    // so the delta covers GPU init + WS handshake + first paint.
    const phaseEnterPerfNow = performance.now();

    runGameSurfaceConnectFlow({
      el,
      renderer,
      useWorker,
      gameClient,
      keyboard,
      touchInput: touchInputRef.current,
      phaseEnterPerfNow,
      isDisposed: () => disposed,
      galaxyLayerRef,
      animFrameRef,
      roomNameOverride,
      joinOptionsOverride,
      onEngageTransit: handleEngageTransit,
      onConnectionStatus: setConnectionStatus,
      onPlayerId: setPlayerId,
      onSectorName: setSectorName,
      surfaceMode,
      overlayMode,
      onSelectorPick: handleSelectorPick,
      onSelectorDeselect: handleSelectorDeselect,
    }).catch((err: unknown) => {
      logEvent('game_surface_connect_failed', { err: String(err) });
      setConnectionStatus('error');
    });

    // Keep the in-game Pixi galaxy layer's screen-space layout in sync with
    // the canvas container on resize / orientation change. Mirrors the
    // PixiRenderer's own ResizeObserver but for the screen-space overlay
    // (the renderer's observer only resizes the world viewport).
    const layerRO = new ResizeObserver(() => {
      const layer = galaxyLayerRef.current;
      if (!layer) return;
      layer.resize(el.clientWidth || window.innerWidth, el.clientHeight || window.innerHeight);
    });
    layerRO.observe(el);

    return () => {
      disposed = true;
      cancelAnimationFrame(animFrameRef.current);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('pointerdown', onPointerDownType, { capture: true });
      layerRO.disconnect();
      // Plan: crispy-kazoo, Commit 6 — cleanup ordering.
      // 1. Null the singleton FIRST so consumers reaching for the client
      //    via `getGameClient()` get null, not a half-disposed ref.
      // 2. Tear down input next (it doesn't depend on renderer / audio).
      // 3. Renderer BEFORE audio — effects subsystem fires audio events
      //    during shutdown; audio must still be alive for that handoff.
      // 4. Audio AFTER renderer.
      // 5. Client dispose LAST (carries the reflection-based mirror
      //    clear + every subsystem dispose).
      //
      // 2026-05-31: each dispose step wrapped so a throw doesn't silently
      // skip later steps (the orphaned ColyseusGameClient pattern in
      // capture `hlqxy6` — 4 client_constructed / 3 dispose_complete —
      // is consistent with `renderer.dispose()` throwing partway through
      // and skipping `gameClient.dispose()`). Each failure becomes a
      // discrete `cleanup_step_failed` event that survives `?diag=0`.
      const stepLog = (step: string, err: unknown): void => {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          logEvent('cleanup_step_failed', { step, error: msg });
        } catch { /* ignore — logger may be torn down */ }
      };
      try { setGameClient(null); } catch (e) { stepLog('setGameClient(null)', e); }
      try { keyboard.dispose(); } catch (e) { stepLog('keyboard.dispose', e); }
      // Layer is a child of renderer.app.stage — the renderer's destroy({
      // children: true }) frees it. Nulling the ref so the React-side
      // subscriptions short-circuit on the post-unmount tail.
      galaxyLayerRef.current = null;
      try { renderer.dispose(); } catch (e) { stepLog('renderer.dispose', e); }
      try { audioRef.current?.dispose(); } catch (e) { stepLog('audio.dispose', e); }
      audioRef.current = null;
      try { gameClient.dispose(); } catch (e) { stepLog('gameClient.dispose', e); }
    };
  }, [setConnectionStatus, setPlayerId, setSectorName, roomNameOverride, joinOptionsOverride, toggleGalaxyMap, handleEngageTransit, surfaceMode, overlayMode, handleSelectorPick, handleSelectorDeselect]);

  // Reactive sync from Zustand to the Pixi galaxy layer. The layer is
  // constructed inside the main mount effect (async after renderer.init)
  // and these effects are no-ops until that ref populates; the initial
  // values are also pushed in once at construction time so we never miss
  // the first paint.
  const galaxyLayerCurrentSectorKey = useUIStore((s) => s.currentSectorKey);
  const galaxyLayerTransitState = useUIStore((s) => s.transitState);
  const galaxyStats = useUIStore((s) => s.galaxyStats);
  const galaxyOwnedStructures = useUIStore((s) => s.galaxyOwnedStructures);
  const shipRoster = useUIStore((s) => s.shipRoster);
  // Poll GET /galaxy/snapshot while a galaxy map is on screen (idle selector or
  // the in-game overlay open) → store.galaxyStats → the layer's count glyphs.
  useGalaxyStats(idle || galaxyMapOpen);
  // Equinox Phase 7 — poll the player's owned-structure presence alongside the
  // global snapshot (ship locations come from the roster, merged in below).
  useGalaxyPresence(idle || galaxyMapOpen, loadStoredPlayerId());
  // Each effect routes BOTH paths: `galaxyLayerRef.current` is set
  // only in DOM-renderer mode (Safari fallback). In worker-renderer
  // mode the layer lives inside the worker; state crosses via the
  // `WorkerRendererClient.setLayer*` postMessages.
  useEffect(() => {
    // Idle (selector) picker is ALWAYS visible — it's the whole screen.
    // The additive overlay (connect mode) follows the MAP-button toggle.
    syncGalaxyVisibility(galaxyLayerRef.current, rendererRef.current, idle ? true : galaxyMapOpen);
  }, [galaxyMapOpen, idle]);
  useEffect(() => {
    syncGalaxyCurrentSector(galaxyLayerRef.current, rendererRef.current, galaxyLayerCurrentSectorKey);
  }, [galaxyLayerCurrentSectorKey]);
  useEffect(() => {
    syncGalaxyTransitDocked(galaxyLayerRef.current, rendererRef.current, galaxyLayerTransitState === 'DOCKED');
  }, [galaxyLayerTransitState]);
  useEffect(() => {
    syncGalaxyStats(galaxyLayerRef.current, rendererRef.current, galaxyStats);
  }, [galaxyStats]);
  // Equinox Phase 7 — merge the player's owned structures (GET /galaxy/presence)
  // + ship locations (roster) into the per-sector "my presence" overlay, pushed
  // dual-path to the galaxy map. Merge logic (incl. the active-ship → live
  // currentSectorKey override) is the pure, unit-locked mergePlayerPresence.
  useEffect(() => {
    const presence = mergePlayerPresence(galaxyOwnedStructures, shipRoster, galaxyLayerCurrentSectorKey);
    syncGalaxyPresence(galaxyLayerRef.current, rendererRef.current, presence);
  }, [galaxyOwnedStructures, shipRoster, galaxyLayerCurrentSectorKey]);

  // Pixi 30 Hz throttle while the AdvancedDrawer is open. At 60 Hz the
  // main thread is saturated enough that Playwright's CDP roundtrip
  // climbs to ~500 ms median (measured 2026-05-14 via
  // `tests/e2e/drawer-cdp-starvation-probe.spec.ts`), which makes
  // drawer-interactive E2E specs time out at 30 s on what should be
  // sub-second waits. While the drawer is open the user is focused on
  // UI not the game, so the gameplay frame-rate drop is invisible.
  // See `docs/LESSONS.md` 2026-05-13 §6.
  const isDrawerOpen = useUIStore((s) => s.isDrawerOpen);
  const isGalaxyOverviewOpen = useUIStore((s) => s.isGalaxyOverviewOpen);
  // **Real users get full 60 fps even when overlays are open** — the
  // drawer is partial-width and the gameplay underneath should keep
  // animating at full rate. We ONLY intervene under Playwright
  // automation (navigator.webdriver === true), where Pixi's rAF tax
  // starves the CDP protocol loop to ~500 ms median roundtrip. There
  // we pause the ticker entirely while the drawer/overview is open so
  // E2E specs aren't flaky against a 120 s test budget. Production
  // never hits the pause path.
  const uiCoversGame = isDrawerOpen || isGalaxyOverviewOpen;
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const isAutomation = typeof navigator !== 'undefined' && navigator.webdriver === true;
    if (!isAutomation) {
      renderer.setTickerMaxFPS(undefined);
      return;
    }
    renderer.setTickerMaxFPS(uiCoversGame ? null : undefined);
  }, [uiCoversGame]);

  // LayoutProvider + FullscreenToggle live at the App level (not here) so the
  // toggle persists across every phase — meta, auth, galaxy-map, game.
  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        // dvh: dynamic viewport height — accounts for mobile URL bar show/hide.
        // Falls back to 100vh on older browsers (iOS < 15.4).
        '@supports (height: 100dvh)': { height: '100dvh' },
        overflow: 'hidden',
        bgcolor: '#05070f',
        touchAction: 'none',
      }}
    >
      <div
        ref={containerRef}
        data-testid="game-surface"
        style={{
          width: '100%',
          height: '100%',
          touchAction: 'none',
          // GPU layer promotion 2026-05-13. Without this hint, Chromium
          // composites the Pixi WebGL canvas every frame against the
          // overlaid HTML/MUI elements, triggering readPixels stalls
          // visible as "GPU stall due to ReadPixels (High)" warnings.
          // `transform: translateZ(0)` (or `will-change: transform`)
          // promotes the canvas to its own compositor layer so the
          // upper HTML elements composite over it without a readback.
          transform: 'translateZ(0)',
          willChange: 'transform',
        }}
      />
      {idle ? (
        <GalaxyPickerChrome
          apiRef={pickerApiRef}
          onSelectRoom={onSelectRoom}
          onSpawnExistingShip={onSpawnExistingShip}
          onSpawnNewShip={onSpawnNewShip}
          onSelectLocal={onSelectLocal}
        />
      ) : (
        <>
      <Slot anchor="top-left" order={1}><SectorInfoPanel /></Slot>
      <Slot anchor="top-left" order={2}><ShieldHullBar /></Slot>
      <Slot anchor="top-left" order={10}><Hud /></Slot>
      <Slot anchor="top-center" order={1}><EnergyBar /></Slot>
      <Slot anchor="top-center" order={2}><WarpInWarningBanner /></Slot>
      <Slot anchor="top-right" order={2}><ShipStatsCard getLocalShip={getLocalShip} /></Slot>
      <AdvancedDrawer />
      <DeathOverlay onRespawn={handleRespawn} />
      {isTouchRef.current && touchInputRef.current && (
        <MobileControls touchInput={touchInputRef.current} />
      )}
      {/* Speed-dial UI refactor (Phase 1): the discrete (tap) HUD actions —
       *  Map toggle, weapon-slot select, and the drawer/panels entry — are
       *  consolidated into a single SpeedDial in the bottom-right anchor. It
       *  sits to the LEFT of the held FIRE/BOOST cluster on touch (order 30 >
       *  their 10/20 in the row-reverse anchor, so those keep their corner
       *  positions) and in the corner on desktop. The held controls
       *  (joystick/FIRE/BOOST) stay dedicated in MobileControls. Phase 2 adds
       *  the "Build ▸" structure-placement actions to the same dial. */}
      {/* Auto-fire mode toggle — shown on BOTH desktop and touch (default ON).
       *  order=5 keeps it rightmost in the row-reverse cluster; on touch it sits
       *  where FIRE would be when auto-fire is OFF (MobileControls hides FIRE
       *  while ON). */}
      <Slot anchor="bottom-right" order={5}><AutoFireToggleButton /></Slot>
      {/* Speed-dial at order=1 = the corner-most control (lowest order wins the
       *  corner in the row-reverse bottom-right anchor), to the right of AUTO
       *  (5) and FIRE/BOOST (10/20). Smoke handoff 2026-06-06, Issue 3:
       *  "the speed dial is in the wrong place" → bottom-right corner. */}
      <Slot anchor="bottom-right" order={1}><SpeedDialMenu /></Slot>
      {/* Structures plan (Phase 3): grid net-power readout (top-left). */}
      <Slot anchor="top-left" order={40}><GridPowerReadout /></Slot>
      {/* Click-to-inspect live stats (structures follow-up Item B6). Visible
       *  only while an entity is selected. WS-9 (R2.30) — WORLD-ANCHORED: rendered
       *  OUTSIDE the Slot system as a `position:fixed` element that gameRafLoop
       *  moves to the renderer's projection of the selected entity (any kind). */}
      <EntityStatsPanel />
      <HyperspaceOverlay onCancel={handleCancelTransit} />
      {/* Structure placement confirm — WORLD-ANCHORED (smoke handoff 2026-06-06,
       *  Issue 5). Rendered OUTSIDE the Slot system as a `position:fixed`,
       *  high-z element so it sits ABOVE the thumb-cluster/dial (the old
       *  bottom-center/Z.hud slot put it UNDER them on mobile). gameRafLoop
       *  moves it to the projected on-screen position of the blueprint ghost. */}
      <StructurePlacementBanner />
      <LostConnectionOverlay />
      {/* Equinox Phase 7 (Item 1) — the in-game full-page WARP map: the SAME
       *  GalaxyPickerChrome (context='warp') over the full-page selector layer
       *  (the translucent overlay is retired). Opened by the Map toggle
       *  (isGalaxyMapOpen). Tap a hex → info popover; "Warp here" warps to an
       *  adjacent neighbour; a roster row hot-swaps ships; Close dismisses. */}
      {galaxyMapOpen && (
        <GalaxyPickerChrome
          context="warp"
          apiRef={pickerApiRef}
          onClose={() => useUIStore.getState().setGalaxyMapOpen(false)}
          onWarp={(sectorKey) => {
            handleEngageTransit(sectorKey);
            // Close the map so the HyperspaceOverlay spool bar shows over the game.
            useUIStore.getState().setGalaxyMapOpen(false);
          }}
          onSpawnExistingShip={(shipId, sectorKey) => {
            useUIStore.getState().setPendingShipSwap({ shipId, sectorKey });
            useUIStore.getState().setGalaxyMapOpen(false);
          }}
        />
      )}
      {galaxyOverviewOpen && (
        <Slot anchor="fullscreen" order={25}>
          {/* In-game ship-swap overview — roster-pick only over the live
              game (single-canvas refactor: Map A's second Pixi
              Application is retired). Warp lives on the bottom-center MAP
              button / M-key overlay (`GalaxyMapLayer`). */}
          <GalaxyOverviewSelectChrome
            onClose={() => setGalaxyOverviewOpen(false)}
          />
        </Slot>
      )}
        </>
      )}
      <HudTestAttributes />
    </Box>
  );
}


export function App(): JSX.Element {
  // Phase 8 — autoJoin escape hatch: ?room= or ?galaxy= bypasses meta + auth
  // and goes straight into the game so existing E2E tests and deep links
  // keep working.
  const initialUrlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const autoJoinRoom = initialUrlParams.get('room');
  const autoJoinGalaxy = initialUrlParams.get('galaxy');
  const autoJoin = autoJoinRoom !== null || autoJoinGalaxy !== null;
  const initialOverride = autoJoinRoom ?? (autoJoinGalaxy ? `galaxy-${autoJoinGalaxy}` : null);
  // E2E escape hatch (2026-05-13): force the auto-join to fresh-spawn a
  // NEW ship rather than rebinding/reusing the player's most-recent
  // roster row. Production UI uses `GalaxyOverviewScreen.handleSpawnNewShip`
  // for the same intent; this URL flag lets multi-ship-roster tests
  // build their fixture state without going through the spawn-select UI.
  const autoJoinNewShip = initialUrlParams.get('newShip') === '1';
  const initialJoinOpts: Record<string, unknown> | undefined = autoJoinNewShip
    ? { isNewShip: true }
    : undefined;

  const { user } = useAuthStore();
  // Phase machine lives in Zustand so drawer tabs (Settings "Return to menu",
  // Profile Logout) can change it without prop-drilling through 4 components.
  // Default initial value in the store is 'meta'; autoJoin overrides on mount.
  const phase = useUIStore((s) => s.phase);
  const setPhase = useUIStore((s) => s.setPhase);
  const [roomNameOverride, setRoomNameOverride] = useState<string | undefined>(
    initialOverride ?? undefined,
  );
  /** Phase 3 multi-ship roster — extra join options threaded through to
   *  Colyseus when the player spawns into a specific roster ship. Cleared
   *  on every legacy sector-click so the override only applies for the
   *  roster-card flow. */
  const [joinOptionsOverride, setJoinOptionsOverride] = useState<Record<string, unknown> | undefined>(initialJoinOpts);
  const [profileOpen, setProfileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // Apply autoJoin once on mount — overrides the store's default 'meta'.
  // Subsequent phase changes are user-driven (drawer buttons, login flow).
  const autoJoinRef = useRef(autoJoin);
  useEffect(() => {
    if (autoJoinRef.current) setPhase('game');
  }, [setPhase]);

  useAuthExpiryRedirect();
  useUserPrefsHydration();
  // App-level diagnostic logging (2026-05-13). Mount lifecycle + phase
  // transitions + serverHealth transitions go into the same ring buffer
  // the diag capture exports. Logs are cheap (~80 bytes each) and
  // fire at most a handful of times per session, so the perf impact
  // is well below the noise floor.
  useMountLog('App');
  usePhaseChangeLog(phase);
  useServerHealthPoll();

  const handleSelectRoom = useCallback((roomName: string) => {
    setRoomNameOverride(roomName);
    // Clear roster shipId override — legacy sector-click is a fresh spawn
    // (or implicit limbo-resume), not a specific-ship resume.
    setJoinOptionsOverride(undefined);
    setPhase('game');
  }, [setPhase]);

  const handleSpawnExistingShip = useCallback((shipId: string, sectorKey: string) => {
    setRoomNameOverride(`galaxy-${sectorKey}`);
    setJoinOptionsOverride({ shipId });
    setPhase('game');
  }, [setPhase]);

  useShipSwapDispatcher(setRoomNameOverride, setJoinOptionsOverride);

  const handleSpawnNewShip = useCallback((_kind: unknown, sectorKey: string) => {
    // ShipKind already lives in Zustand `selectedShipKind` (the picker
    // modal's onSelect sets it before invoking this callback). The server
    // reads shipKind from JoinOptions via ColyseusClient.connect, which
    // pulls it from Zustand. We only need to add `isNewShip: true` to
    // force a fresh roster row instead of resuming the most-recent.
    setRoomNameOverride(`galaxy-${sectorKey}`);
    setJoinOptionsOverride({ isNewShip: true });
    setPhase('game');
  }, [setPhase]);

  const handleSelectLocal = useCallback(() => {
    setPhase('local');
  }, [setPhase]);

  const handleAuthSuccess = useCallback(() => {
    setPhase('galaxy-map');
  }, [setPhase]);

  // Meta-landing CTA: if logged in, jump to galaxy-map; else, login flow
  // first (the post-auth handler then continues on to galaxy-map).
  const handleJoinFromMeta = useCallback(() => {
    setPhase(user ? 'galaxy-map' : 'auth');
  }, [user, setPhase]);

  // Per-phase content composition lives in PhaseRouter — the App
  // wraps it in LayoutProvider + ErrorBoundary so the
  // TopRightToolbar / WarpScreen persist across phase transitions.
  return (
    <ErrorBoundary>
      <LayoutProvider>
        <PhaseRouter
          phase={phase}
          user={user}
          profileOpen={profileOpen}
          setProfileOpen={setProfileOpen}
          settingsOpen={settingsOpen}
          openSettings={openSettings}
          closeSettings={closeSettings}
          setPhase={setPhase}
          gameSurface={
            <GameSurface
              surfaceMode={phase === 'galaxy-map' ? 'idle' : 'connect'}
              roomNameOverride={roomNameOverride}
              joinOptionsOverride={joinOptionsOverride}
              onSelectRoom={handleSelectRoom}
              onSpawnExistingShip={handleSpawnExistingShip}
              onSpawnNewShip={handleSpawnNewShip}
              onSelectLocal={handleSelectLocal}
            />
          }
          onJoinFromMeta={handleJoinFromMeta}
          onSelectLocal={handleSelectLocal}
          onAuthSuccess={handleAuthSuccess}
        />
        <TopRightToolbar />
        {/* Unified warp-screen overlay. Internally null when phase !==
            'game' && !== 'connecting'; auto-fades on `gameReady`. Mounted
            at the layout root so phase transitions (e.g. connecting →
            game) don't unmount/remount it and lose the fade animation. */}
        <WarpScreen />
      </LayoutProvider>
    </ErrorBoundary>
  );
}
