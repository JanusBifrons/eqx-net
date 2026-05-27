import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { installWindowLogger } from './debug/ClientLogger';
import { installStreamingDiag } from './debug/streamingDiag';
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
} from './app/galaxyOverlay';
import type { IRenderer } from '@core/contracts/IRenderer';
import { GalaxyMapLayer } from './render/galaxy/GalaxyMapLayer';
import { Keyboard } from './input/Keyboard';
import { TouchInput, isTouchDevice } from './input/TouchInput';
import { useUIStore, useGameReady } from './state/store';
import { useAuthStore } from './auth/authStore';
import { MobileControls } from './components/MobileControls';
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
import { WeaponSelector } from './components/WeaponSelector';
import { GalaxyMapToggleButton } from './components/GalaxyMapToggleButton';
import { Hud } from './components/Hud';
import { SectorInfoPanel } from './components/SectorInfoPanel';
import { HudTestAttributes } from './components/HudTestAttributes';
import { ShieldHullBar } from './components/ShieldHullBar';
import { GalaxyOverviewScreen } from './components/GalaxyOverviewScreen';
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

interface GameSurfaceProps {
  /** Phase 8 — room name chosen by the lobby/galaxy-map screen. Falls back
   *  to the URL `?room=` / `?galaxy=` params or `'sector'` when undefined,
   *  preserving the E2E auto-join escape hatch. */
  roomNameOverride?: string;
  /** Phase 3 multi-ship roster — extra join options forwarded to the
   *  Colyseus `joinOrCreate` call. Used by the roster-panel Spawn flow
   *  to thread the chosen `shipId` to the server's `onJoin`. */
  joinOptionsOverride?: Record<string, unknown>;
}

function GameSurface({ roomNameOverride, joinOptionsOverride }: GameSurfaceProps): JSX.Element {
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
  // Join-render diagnostic anchor — captured once per GameSurface mount.
  // Used by the `join_chain_complete` event below + by the rAF loop's
  // `pixi_first_frame` payload.
  const gameSurfaceMountedAtRef = useRef<number>(performance.now());
  const joinChainCompleteLoggedRef = useRef<boolean>(false);
  const gameReady = useGameReady();
  const { setConnectionStatus, setPlayerId, setSectorName } = useUIStore();

  // Fire `join_chain_complete` exactly once per GameSurface mount, when
  // all four readiness gates (connected + welcomed + first-snapshot OR
  // timeout + first-frame-rendered) have flipped true. Pairs with
  // `pixi_first_frame` and `local_pose_resolved` so the diagnostic
  // capture has both the per-gate events AND a single summary event
  // with total elapsed time.
  useEffect(() => {
    if (gameReady && !joinChainCompleteLoggedRef.current) {
      joinChainCompleteLoggedRef.current = true;
      logEvent('join_chain_complete', {
        msFromPhaseEnter: Math.round(performance.now() - gameSurfaceMountedAtRef.current),
      });
    }
  }, [gameReady]);

  // Minimum-display-time floor for the WarpScreen. 5 s gives the
  // reconciler enough wall-clock to receive its first snapshot, apply
  // its first server→client correction, and settle BEFORE the user
  // sees the canvas. Without this floor, the warp hides at the spawn
  // pose and the first-move-teleport user symptom resurfaces
  // (2026-05-14 capture `2026-05-14T21-39-07-346Z-tkc6ad` showed a
  // 311-unit drift correction landing pre-capture-window).
  //
  // Keyed on `joinGeneration` (Phase G): a pure inter-sector transit
  // keeps `phase==='game'` so GameSurface does NOT remount — a
  // mount-scoped `[]` effect would arm the floor exactly once per
  // session and never again, so the 2nd+ transit had no floor and the
  // WarpScreen never re-showed. `rearmJoinReadiness()` (from the
  // `transit_ready` handler) bumps `joinGeneration`; the dep change
  // tears down the stale timer (cleanup) and re-runs a fresh 5 s
  // floor. The literal `setTimeout(…, 5000)` is unchanged — the floor
  // is NOT weakened, it now re-runs instead of never.
  const joinGeneration = useUIStore((s) => s.joinGeneration);
  useEffect(() => {
    const timer = setTimeout(() => {
      useUIStore.getState().setJoinMinimumElapsed(true);
    }, 5000);
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
  // will reflect the wreck (Phase 4 already destroys the dead ship's
  // roster row, so it disappears).
  //
  // We also clear every transient in-game overlay flag (galaxy map open,
  // overview open, drawer open, pending swap) so a player who died with
  // any of those mounted doesn't see them re-appear on their next spawn.
  // This is the edge case captured 2026-05-13: die-while-galaxy-overview-
  // open left `isGalaxyOverviewOpen=true` in the store; the next spawn
  // saw the overview pop back open immediately on top of the fresh game.
  const handleRespawn = useCallback(() => {
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
    gameClient.setAudio(new HowlerAudioService());
    clientRef.current = gameClient;
    // Module-level singleton so low-cadence React reads (e.g. the Galaxy
    // tab's 5 s arrival-snapshot poll) can reach `mirror` without prop
    // drilling. See `src/client/net/clientSingleton.ts`.
    setGameClient(gameClient);
    // Expose for the dev-only diagnostic capture (SettingsModal "Capture" button
    // reads `__eqxClient.stats`). DEV-only assignment guarded by Vite's tree-shaking.
    if (import.meta.env.DEV) {
      (window as unknown as { __eqxClient?: ColyseusGameClient }).__eqxClient = gameClient;
      // Test-only hook for E2E specs: expose enough of the UI store to
      // set `activeWeapon` without going through the KeyQ-cycle. The
      // Q-cycle path has surfaced Playwright keyboard-focus quirks
      // that silently drop subsequent Space presses; setting the
      // active weapon directly sidesteps that. Production tree-shakes.
      (window as unknown as { __eqxSetActiveWeapon?: (id: string) => void })
        .__eqxSetActiveWeapon = (id: string) => {
          useUIStore.getState().setActiveWeapon(id as Parameters<ReturnType<typeof useUIStore.getState>['setActiveWeapon']>[0]);
        };
    }

    const onKey = (e: KeyboardEvent): void => {
      // Phase 8 sub-phase B — toggle the in-game galaxy-map overlay. 'M' is
      // unmodified so it's reachable on a keyboard during play; the overlay
      // disables itself if `transitState !== 'DOCKED'`.
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'm' || e.key === 'M')) {
        toggleGalaxyMap();
      }
    };
    window.addEventListener('keydown', onKey);

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
    }).catch((err: unknown) => {
      console.error('[GameSurface] connection failed', err);
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
      layerRO.disconnect();
      keyboard.dispose();
      gameClient.dispose();
      setGameClient(null);
      // Layer is a child of renderer.app.stage — the renderer's destroy({
      // children: true }) frees it. Nulling the ref so the React-side
      // subscriptions short-circuit on the post-unmount tail.
      galaxyLayerRef.current = null;
      renderer.dispose();
    };
  }, [setConnectionStatus, setPlayerId, setSectorName, roomNameOverride, joinOptionsOverride, toggleGalaxyMap, handleEngageTransit]);

  // Reactive sync from Zustand to the Pixi galaxy layer. The layer is
  // constructed inside the main mount effect (async after renderer.init)
  // and these effects are no-ops until that ref populates; the initial
  // values are also pushed in once at construction time so we never miss
  // the first paint.
  const galaxyLayerCurrentSectorKey = useUIStore((s) => s.currentSectorKey);
  const galaxyLayerTransitState = useUIStore((s) => s.transitState);
  // Each effect routes BOTH paths: `galaxyLayerRef.current` is set
  // only in DOM-renderer mode (Safari fallback). In worker-renderer
  // mode the layer lives inside the worker; state crosses via the
  // `WorkerRendererClient.setLayer*` postMessages.
  useEffect(() => {
    syncGalaxyVisibility(galaxyLayerRef.current, rendererRef.current, galaxyMapOpen);
  }, [galaxyMapOpen]);
  useEffect(() => {
    syncGalaxyCurrentSector(galaxyLayerRef.current, rendererRef.current, galaxyLayerCurrentSectorKey);
  }, [galaxyLayerCurrentSectorKey]);
  useEffect(() => {
    syncGalaxyTransitDocked(galaxyLayerRef.current, rendererRef.current, galaxyLayerTransitState === 'DOCKED');
  }, [galaxyLayerTransitState]);

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
      <Slot anchor="top-left" order={1}><SectorInfoPanel /></Slot>
      <Slot anchor="top-left" order={2}><ShieldHullBar /></Slot>
      <Slot anchor="top-left" order={10}><Hud /></Slot>
      <Slot anchor="top-right" order={2}><ShipStatsCard getLocalShip={getLocalShip} /></Slot>
      <AdvancedDrawer />
      <DeathOverlay onRespawn={handleRespawn} />
      {isTouchRef.current && touchInputRef.current && (
        <MobileControls touchInput={touchInputRef.current} />
      )}
      {/* WeaponSelector and the MAP toggle live in different anchors on
       *  touch vs. desktop. On touch, MobileControls renders WeaponSelector
       *  inline above FIRE in the bottom-right thumb cluster, and the MAP
       *  toggle goes above the joystick in bottom-left. On desktop both
       *  stay at bottom-center where the player is more likely looking. */}
      {!isTouchRef.current && (
        <Slot anchor="bottom-center" order={5}><WeaponSelector /></Slot>
      )}
      {isTouchRef.current ? (
        <Slot anchor="bottom-left" order={10}><GalaxyMapToggleButton /></Slot>
      ) : (
        <Slot anchor="bottom-center" order={10}><GalaxyMapToggleButton /></Slot>
      )}
      <HyperspaceOverlay onCancel={handleCancelTransit} />
      <LostConnectionOverlay />
      {galaxyOverviewOpen && (
        <Slot anchor="fullscreen" order={25}>
          {/* In-game overview is roster-pick only. Warp is reserved for
              the bottom-center MAP button / M-key overlay
              (`GalaxyMapLayer`). Refactor 2026-05-13. */}
          <GalaxyOverviewScreen
            mode="select"
            onClose={() => setGalaxyOverviewOpen(false)}
          />
        </Slot>
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
              roomNameOverride={roomNameOverride}
              joinOptionsOverride={joinOptionsOverride}
            />
          }
          onJoinFromMeta={handleJoinFromMeta}
          onSelectLocal={handleSelectLocal}
          onAuthSuccess={handleAuthSuccess}
          onSelectRoom={handleSelectRoom}
          onSpawnExistingShip={handleSpawnExistingShip}
          onSpawnNewShip={handleSpawnNewShip}
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
