import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { installWindowLogger } from './debug/ClientLogger';
import {
  Box,
  Button,
  Typography,
  CircularProgress,
} from '@mui/material';
import { ColyseusGameClient } from './net/ColyseusClient';
import { setGameClient } from './net/clientSingleton';
import { HowlerAudioService } from './audio/HowlerAudioService';
import { PixiRenderer } from './render/PixiRenderer';
import { WorkerRendererClient, supportsOffscreenRenderer } from './render/worker/WorkerRendererClient';
import type { IRenderer } from '@core/contracts/IRenderer';
import { GalaxyMapLayer } from './render/galaxy/GalaxyMapLayer';
import { Keyboard } from './input/Keyboard';
import { TouchInput, isTouchDevice } from './input/TouchInput';
import { LocalGameClient } from './local/LocalGameClient';
import { loadStoredPlayerId, persistPlayerId } from './identity/token';
import { useUIStore, applyUserPrefs } from './state/store';
import { useAuthStore } from './auth/authStore';
import { AppHeader } from './components/AppHeader';
import { LoginPage } from './components/LoginPage';
import { ProfileModal } from './components/ProfileModal';
import { SettingsModal } from './components/SettingsModal';
import { MobileControls } from './components/MobileControls';
import { GalaxyOverviewScreen } from './components/GalaxyOverviewScreen';
import { ErrorBoundary } from './components/ErrorOverlay';
import { HyperspaceOverlay } from './components/HyperspaceOverlay';
import { LostConnectionOverlay } from './components/LostConnectionOverlay';
import { engageTransit, cancelTransit } from './net/transitClient';
import { createServerHealthPoller } from './net/serverHealthPoller';
import { logEvent } from './debug/ClientLogger';
import { useMountLog } from './debug/useMountLog';
import { ShipStatsCard } from './components/ShipStatsCard';
import { WeaponSelector } from './components/WeaponSelector';
import { GalaxyMapToggleButton } from './components/GalaxyMapToggleButton';
import { Hud } from './components/Hud';
import { SectorInfoPanel } from './components/SectorInfoPanel';
import { HudTestAttributes } from './components/HudTestAttributes';
import { MetaLandingScreen } from './components/MetaLandingScreen';
import { LayoutProvider } from './layout/LayoutProvider';
import { Slot } from './layout/Slot';
import { AdvancedDrawer } from './layout/Drawer/AdvancedDrawer';
import { TopRightToolbar } from './layout/TopRightToolbar';
import { MobileAvatarBadge } from './layout/MobileAvatarBadge';
import { getSector } from '../core/galaxy/galaxy';

// Default to the page's own origin so the same dev server is reachable from
// phones on the LAN (e.g. http://192.168.1.5:5173 → ws://192.168.1.5:5173).
// Override with VITE_WS_URL in .env for cross-origin setups.
const SERVER_URL =
  import.meta.env['VITE_WS_URL'] ??
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173');

// Install window.__eqxLogs and window.__eqxClearLogs at module load time.
installWindowLogger();

function DeathOverlay({ onRespawn }: { onRespawn: () => void }): JSX.Element | null {
  const isDead = useUIStore((s) => s.isDead);
  if (!isDead) return null;
  return (
    <Slot anchor="fullscreen" order={10}>
      <Box
        data-testid="death-overlay"
        sx={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'rgba(0,0,0,0.65)',
          gap: 3,
        }}
      >
        <Typography
          variant="h2"
          sx={{ color: '#ff3333', fontWeight: 700, letterSpacing: 6, textTransform: 'uppercase', textShadow: '0 0 30px #ff0000' }}
        >
          You Died
        </Typography>
        <Button
          variant="contained"
          size="large"
          onClick={onRespawn}
          sx={{
            bgcolor: '#00ff88',
            color: '#000',
            fontWeight: 700,
            px: 6,
            fontSize: '1.1rem',
            '&:hover': { bgcolor: '#00cc6a' },
          }}
        >
          Respawn
        </Button>
      </Box>
    </Slot>
  );
}

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
  const { setConnectionStatus, setPlayerId, setSectorName } = useUIStore();

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

    // OffscreenCanvas migration: when the browser supports
    // `OffscreenCanvas.transferControlToOffscreen()` (Chrome, Firefox,
    // Safari 17+), construct the worker-backed renderer so Pixi runs
    // off the main thread. Otherwise fall back to the main-thread
    // PixiRenderer — same class, same render code-path, same Camera.
    // See ~/.claude/plans/humble-strolling-coral.md.
    const useWorker = supportsOffscreenRenderer();
    const renderer: IRenderer = useWorker ? new WorkerRendererClient() : new PixiRenderer();
    rendererRef.current = renderer;

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
    let firstFramePixiLogged = false;

    (async () => {
      const rendererInitStartedAt = performance.now();
      await renderer.init(el);
      const rendererInitMs = performance.now() - rendererInitStartedAt;

      // StrictMode fires cleanup before the async init resolves. If disposal
      // happened while we were awaiting, tear down the just-initialised renderer
      // (which appended a canvas) and exit — the second mount will take over.
      if (disposed) {
        renderer.dispose();
        return;
      }
      logEvent('renderer_init_complete', {
        rendererInitMs: Math.round(rendererInitMs),
        msFromPhaseEnter: Math.round(performance.now() - phaseEnterPerfNow),
      });

      // Map B — additive in-game galaxy overlay. Lives as a screen-space
      // sibling of the gameplay viewport on the same Pixi stage, so it
      // doesn't pan/zoom with the world camera and Pixi's hit-testing
      // routes hex taps cleanly while non-hex regions pass through to
      // gameplay underneath.
      //
      // Worker-renderer path: GalaxyMapLayer's Pixi handle can't cross
      // the worker boundary. Skip its construction; the M-key overlay
      // is temporarily unavailable in worker context. Follow-up commit
      // will move the layer worker-side with state-driven postMessages.
      if (!useWorker) {
        const galaxyLayer = new GalaxyMapLayer({
          onSelect: (key) => {
            handleEngageTransit(key);
            // Auto-close the additive overlay on warp-tap; the user explicitly
            // asked for tap-to-warp to dismiss the map (otherwise it stays
            // visible during SPOOLING and feels stuck).
            useUIStore.getState().setGalaxyMapOpen(false);
          },
        });
        renderer.addOverlayContainer(galaxyLayer);
        const s0 = useUIStore.getState();
        galaxyLayer.setCurrentSector(s0.currentSectorKey);
        galaxyLayer.setTransitDocked(s0.transitState === 'DOCKED');
        galaxyLayer.resize(el.clientWidth || window.innerWidth, el.clientHeight || window.innerHeight);
        galaxyLayer.setVisible(s0.isGalaxyMapOpen);
        galaxyLayerRef.current = galaxyLayer;
      }

      let lastFrameTime = 0;
      // E2E-inspection dataset writes are throttled to every 5th frame
      // (12 Hz) — at 60 Hz they were producing 21+ DOM mutations per
      // frame including multiple `JSON.stringify(...)` calls, which
      // measurably blocked the main thread and broke Playwright's
      // "stable click target" detection (drawer-toggle clicks took
      // 2.8–4 s instead of <100 ms). 12 Hz is still plenty for any
      // poll-based E2E spec; specs that need higher cadence can
      // override via the existing `__eqxClient.stats` path.
      let frameCounter = 0;
      // MIRROR_UPDATE throttle for the worker-renderer path. The
      // structured-clone cost of `mirror` (containing Maps of ships +
      // swarm + projectiles + beams) is paid by the main thread on
      // every postMessage. At 60 Hz with ~hundreds of drones this
      // measurably eats CDP roundtrip budget (drawer-cdp-starvation
      // probe p95 climbed to 2.5 s under the worker after the
      // architecture flip — main thread fine, marshaling costly).
      // 30 Hz is well above visual flicker threshold and halves the
      // marshaling cost. Skipped when useWorker is false — the
      // main-thread renderer is a direct call, no postMessage.
      let workerUpdateCounter = 0;
      const loop = (now: number): void => {
        if (!disposed) {
          const deltaMs = lastFrameTime > 0 ? now - lastFrameTime : 1000 / 60;
          lastFrameTime = now;
          gameClient.tickPhysics(deltaMs);
          gameClient.updateMirror();
          const shouldRender = !useWorker || (++workerUpdateCounter % 2) === 0;
          if (shouldRender) renderer.update(gameClient.mirror);
          // Clear one-frame triggers after the renderer has consumed them.
          gameClient.mirror.explodingShips?.clear();

          // Join-render diagnostic: latch the moment the renderer first
          // paints a frame with the local player visible. Drives the
          // future `gameReady` selector + WarpScreen fade-out. Read on
          // EVERY frame (not gated to writeDataset) because the
          // transition we care about happens once per session and we
          // mustn't miss it.
          if (!firstFramePixiLogged) {
            const fb = renderer.getFeedback();
            if (fb.firstFrameRendered) {
              firstFramePixiLogged = true;
              logEvent('pixi_first_frame', {
                msFromPhaseEnter: Math.round(performance.now() - phaseEnterPerfNow),
                shipsInMirror: gameClient.mirror.ships.size,
                hasLocal: gameClient.mirror.localPlayerId !== null,
              });
            }
          }
          const localId = gameClient.mirror.localPlayerId;
          const localShip = localId ? gameClient.mirror.ships.get(localId) : null;
          const writeDataset = (++frameCounter % 5) === 0;
          // Phase 2 of OffscreenCanvas migration: single batched
          // renderer-feedback read per frame. Replaces per-attribute
          // `renderer.mountCountForShip()` / `renderer.getDebugHaloArrowCount()`
          // calls so the future worker-renderer (where each read is a
          // postMessage) lands at a single cached-snapshot lookup site.
          const feedback = writeDataset ? renderer.getFeedback() : null;
          if (localShip && writeDataset && feedback) {
            el.dataset['shipX'] = localShip.x.toFixed(3);
            el.dataset['shipY'] = localShip.y.toFixed(3);
            el.dataset['shipAngle'] = localShip.angle.toFixed(4);
            // Multi-mount/turret refactor (Phase 3): expose the local ship's
            // mount count so E2E specs can assert the new interceptor /
            // gunship kinds wire visible turret sprites. Legacy single-mount
            // fighter/scout/heavy report 1.
            el.dataset['mountCount'] = String(feedback.mountCounts.get(localId!) ?? 0);
          }
          if (writeDataset && feedback) {
          // Expose all ship positions for E2E cross-client position assertions.
          const posMap: Record<string, { x: number; y: number }> = {};
          for (const [id, s] of gameClient.mirror.ships) {
            posMap[id] = { x: parseFloat(s.x.toFixed(3)), y: parseFloat(s.y.toFixed(3)) };
          }
          el.dataset['shipPositions'] = JSON.stringify(posMap);
          el.dataset['localPlayerId'] = localId ?? '';
          el.dataset['predStats'] = JSON.stringify(gameClient.stats);
          // Expose combat state for E2E assertions.
          const uiState = useUIStore.getState();
          el.dataset['hullPct'] = String(uiState.hullPct);
          el.dataset['sectorAlert'] = uiState.sectorAlert ?? '';
          // Phase 6 — TiDi observables for the swarm-tidi / tidi-overlay E2E specs.
          el.dataset['clockRate'] = uiState.clockRate.toFixed(4);
          el.dataset['swarmSize'] = String(gameClient.mirror.swarm?.size ?? 0);
          el.dataset['projectileCount'] = String(gameClient.mirror.projectiles?.size ?? 0);
          el.dataset['haloArrowCount'] = String(feedback.haloArrowCount);
          // Multi-mount/turret refactor (Phase 2c): `liveBeam` became
          // `liveBeams: Map<mountId, ...>`. For legacy single-mount fighter/
          // scout/heavy there is exactly one entry keyed by `'forward'`, so
          // the existing E2E surface (`beamActive`, `beamFromX/Y`, `beamDist`)
          // picks that entry as the "primary" beam. Multi-mount kinds expose
          // every barrel via the same attribute names, separated by commas,
          // so a Phase-3 spec can split on `','` if it wants per-mount data.
          const liveBeams = gameClient.mirror.liveBeams;
          const beamCount = liveBeams?.size ?? 0;
          el.dataset['beamActive'] = beamCount > 0 ? '1' : '0';
          el.dataset['beamCount']  = String(beamCount);
          if (liveBeams && beamCount > 0 && localShip) {
            const xs: string[] = [];
            const ys: string[] = [];
            const ds: string[] = [];
            for (const beam of liveBeams.values()) {
              // The exact mount-local geometry lives in PixiRenderer; the
              // testid surface reports the ship-origin path (where the beam
              // "comes from" semantically) so existing assertions keep
              // working. Phase 3+ may extend this with per-mount world origin.
              const fwdX = -Math.sin(localShip.angle);
              const fwdY =  Math.cos(localShip.angle);
              xs.push((localShip.x + fwdX * 20).toFixed(3));
              ys.push((localShip.y + fwdY * 20).toFixed(3));
              ds.push(beam.dist.toFixed(3));
            }
            el.dataset['beamFromX'] = xs.join(',');
            el.dataset['beamFromY'] = ys.join(',');
            el.dataset['beamDist']  = ds.join(',');
          } else {
            delete el.dataset['beamFromX'];
            delete el.dataset['beamFromY'];
            delete el.dataset['beamDist'];
          }
          // Multi-mount/turret refactor (Phase 2c): `remoteLasers` is now
          // `Map<shooterId, Map<mountId, beam>>`. The E2E surface flattens
          // across mounts — `remoteLaserCount` counts shooters (matches the
          // pre-2c semantic), and `remoteLaserRanges` exposes the maximum
          // beam range per shooter so legacy assertions still work for
          // single-mount ships.
          el.dataset['remoteLaserCount'] = String(gameClient.mirror.remoteLasers?.size ?? 0);
          const remoteHitTargetIds: string[] = [];
          const remoteLaserRanges: Record<string, number> = {};
          if (gameClient.mirror.remoteLasers) {
            for (const [shooterId, perShooter] of gameClient.mirror.remoteLasers) {
              let maxRange = 0;
              for (const l of perShooter.values()) {
                if (l.targetId) remoteHitTargetIds.push(l.targetId);
                if (l.range > maxRange) maxRange = l.range;
              }
              remoteLaserRanges[shooterId] = parseFloat(maxRange.toFixed(2));
            }
          }
          el.dataset['remoteHitTargets'] = JSON.stringify(remoteHitTargetIds);
          el.dataset['remoteLaserRanges'] = JSON.stringify(remoteLaserRanges);
          // Phase 5e: per-entity sleeping flags for the sleep-handshake E2E.
          // Map of entityId → boolean. Empty when there's no swarm in view.
          if (gameClient.mirror.swarm) {
            const sleepMap: Record<string, boolean> = {};
            for (const [entityId, s] of gameClient.mirror.swarm) {
              sleepMap[String(entityId)] = !!s.sleeping;
            }
            el.dataset['swarmSleeping'] = JSON.stringify(sleepMap);
          } else {
            delete el.dataset['swarmSleeping'];
          }
          // Expose swarm positions (asteroids/drones) for E2E collision stability
          // assertions. The string-keyed `data-obstacle-positions` attribute is
          // preserved so existing E2E tests keep working: each swarm entityId is
          // serialised as `swarm-${entityId}` to differentiate from the old
          // hand-rolled `asteroid-N` ids the legacy MapSchema used.
          if (gameClient.mirror.swarm) {
            const swarmMap: Record<string, { x: number; y: number }> = {};
            const swarmDetail: Record<string, { x: number; y: number; angle: number; kind: number; sleeping: boolean; lastUpdateTick: number; radius: number }> = {};
            for (const [entityId, entry] of gameClient.mirror.swarm.entries()) {
              const key = `swarm-${entityId}`;
              swarmMap[key] = { x: parseFloat(entry.x.toFixed(3)), y: parseFloat(entry.y.toFixed(3)) };
              swarmDetail[key] = {
                x: parseFloat(entry.x.toFixed(3)),
                y: parseFloat(entry.y.toFixed(3)),
                angle: parseFloat(entry.angle.toFixed(4)),
                kind: entry.kind,
                sleeping: entry.sleeping,
                lastUpdateTick: entry.lastUpdateTick,
                radius: entry.radius,
              };
            }
            el.dataset['obstaclePositions'] = JSON.stringify(swarmMap);
            el.dataset['swarmDetail'] = JSON.stringify(swarmDetail);
          }
          } // end if (writeDataset)
          animFrameRef.current = requestAnimationFrame(loop);
        }
      };
      animFrameRef.current = requestAnimationFrame(loop);

      const storedId = loadStoredPlayerId();
      const urlParams = new URLSearchParams(window.location.search);
      // Phase 8 — precedence: lobby-chosen override → ?room= (engineering /
      // legacy) → ?galaxy= (deep link to a galaxy sector) → default 'sector'.
      const galaxyParam = urlParams.get('galaxy');
      const roomName =
        roomNameOverride
        ?? urlParams.get('room')
        ?? (galaxyParam ? `galaxy-${galaxyParam}` : 'sector');
      const extraJoinOptions: Record<string, unknown> = { ...(joinOptionsOverride ?? {}) };
      if (urlParams.has('spawnX')) extraJoinOptions['spawnX'] = parseFloat(urlParams.get('spawnX')!);
      if (urlParams.has('spawnY')) extraJoinOptions['spawnY'] = parseFloat(urlParams.get('spawnY')!);
      // Phase 5e: E2E tests pass tunables via URL — `?swarmCount=500` etc.
      if (urlParams.has('swarmCount')) extraJoinOptions['swarmCount'] = parseInt(urlParams.get('swarmCount')!, 10);
      if (urlParams.has('swarmRatio')) extraJoinOptions['swarmRatio'] = parseFloat(urlParams.get('swarmRatio')!);
      if (urlParams.has('swarmRadius')) extraJoinOptions['swarmRadius'] = parseFloat(urlParams.get('swarmRadius')!);
      if (urlParams.has('singleAsteroid')) extraJoinOptions['singleAsteroid'] = urlParams.get('singleAsteroid') === '1';
      if (urlParams.has('tickBurnMs')) extraJoinOptions['tickBurnMs'] = parseFloat(urlParams.get('tickBurnMs')!);

      await gameClient.connect(SERVER_URL, storedId, keyboard, {
        onConnectionStatus: setConnectionStatus,
        onPlayerId: (id) => {
          persistPlayerId(id);
          setPlayerId(id);
        },
      }, roomName, extraJoinOptions, touchInputRef.current ?? undefined);

      // Show the actual room name in the HUD. Previously hardcoded to
      // "Sector Alpha" for any room ≠ test-sector, which made it impossible
      // to tell at a glance whether `?room=swarm-tidi` etc. had actually
      // taken effect.
      const prettyName: Record<string, string> = {
        'sector': 'Sector Alpha',
        'test-sector': 'Test Sector',
        'feel-test': 'Feel Test (10)',
        'swarm-soak': 'Swarm Soak (500)',
        'swarm-tidi': 'Swarm TiDi (4000)',
        'swarm-tidi-burn': 'Swarm TiDi (burn 20 ms)',
      };
      // Phase 8 — galaxy room names are `galaxy-${key}`; resolve the display
      // name from the graph rather than maintaining a parallel map here.
      if (!prettyName[roomName] && roomName.startsWith('galaxy-')) {
        const sec = getSector(roomName.slice('galaxy-'.length));
        if (sec) prettyName[roomName] = sec.name;
      }
      setSectorName(prettyName[roomName] ?? roomName);
    })().catch((err: unknown) => {
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
  useEffect(() => { galaxyLayerRef.current?.setVisible(galaxyMapOpen); }, [galaxyMapOpen]);
  useEffect(() => { galaxyLayerRef.current?.setCurrentSector(galaxyLayerCurrentSectorKey); }, [galaxyLayerCurrentSectorKey]);
  useEffect(() => { galaxyLayerRef.current?.setTransitDocked(galaxyLayerTransitState === 'DOCKED'); }, [galaxyLayerTransitState]);

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

function LocalSurface(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<LocalGameClient | null>(null);
  const rendererRef = useRef<PixiRenderer | null>(null);
  const keyboardRef = useRef<Keyboard | null>(null);
  const animFrameRef = useRef<number>(0);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    let disposed = false;

    const keyboard = new Keyboard();
    keyboardRef.current = keyboard;

    const renderer = new PixiRenderer();
    rendererRef.current = renderer;

    const gameClient = new LocalGameClient();
    clientRef.current = gameClient;

    (async () => {
      await renderer.init(el);
      if (disposed) {
        renderer.dispose();
        return;
      }
      await gameClient.start(keyboard);

      const loop = (_now: number): void => {
        if (!disposed) {
          gameClient.updateMirror();
          renderer.update(gameClient.mirror);
          animFrameRef.current = requestAnimationFrame(loop);
        }
      };
      animFrameRef.current = requestAnimationFrame(loop);
    })().catch((err: unknown) => {
      console.error('[LocalSurface] start failed', err);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(animFrameRef.current);
      keyboard.dispose();
      gameClient.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <Box sx={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden', bgcolor: '#05070f' }}>
      <div ref={containerRef} data-testid="game-surface" style={{ width: '100%', height: '100%' }} />
      <Box sx={{ position: 'absolute', top: 16, left: 16, zIndex: 10, pointerEvents: 'none' }}>
        <Typography variant="overline" sx={{ color: '#ff8800' }}>
          Single-Player Diagnostic — no network
        </Typography>
        <Typography variant="caption" sx={{ display: 'block', color: '#888' }}>
          WASD to move. Three asteroids spawned nearby. If this jitters, the sim itself is bad.
        </Typography>
      </Box>
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

  // If the auth token expires while the user is on the galaxy-map screen
  // (which requires a logged-in user to function), bump them back to the
  // meta landing. Game and local are NOT auto-redirected — let the player
  // finish their round; auth phase is unaffected (already logged out).
  useEffect(() => {
    if (!user && phase === 'galaxy-map') {
      setPhase('meta');
    }
  }, [user, phase, setPhase]);

  // Re-hydrate per-user preferences (settings + selected ship kind) when
  // auth resolves or the active account changes. Anonymous slot is also
  // applied on logout so a stale account's prefs don't leak across.
  useEffect(() => {
    applyUserPrefs(user?.id ?? null);
  }, [user?.id]);

  // App-level diagnostic logging (2026-05-13). Mount lifecycle + phase
  // transitions + serverHealth transitions go into the same ring buffer
  // the diag capture exports. Logs are cheap (~80 bytes each) and
  // fire at most a handful of times per session, so the perf impact
  // is well below the noise floor.
  useMountLog('App');

  useEffect(() => {
    logEvent('phase_change', { phase });
  }, [phase]);

  // Server-health poll loop. Runs for the whole app lifetime — the
  // landing-screen banner + Join-button gate are the primary consumers,
  // but the value also drives the hype-number on `MetaLandingScreen`,
  // so keep polling even after the player joins. The poller is cheap
  // (one HTTP GET every ~8 s in steady state).
  useEffect(() => {
    const setServerHealth = useUIStore.getState().setServerHealth;
    let lastState: string = useUIStore.getState().serverHealth;
    const poller = createServerHealthPoller({
      url: `${SERVER_URL}/healthz`,
      onChange: (snapshot) => {
        const next = snapshot.state === 'healthy'
          ? (snapshot.data?.ready ? 'healthy' : 'warming')
          : snapshot.state; // 'unreachable' | 'unknown'
        // Log only on transitions so we don't fill the ring buffer
        // with steady-state healthy polls (1 every 8s = 7.5/min).
        if (next !== lastState) {
          logEvent('server_health_change', {
            from: lastState,
            to: next,
            playersOnline: snapshot.data?.playersOnline ?? null,
          });
          lastState = next;
        }
        setServerHealth(next, snapshot.data?.playersOnline ?? null);
      },
    });
    poller.start();
    return () => poller.stop();
  }, []);

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

  // Phase 5 — in-game roster swap. Dispatched by `GalaxyTab` via the
  // Zustand `pendingShipSwap` field; we run a `game → connecting → game`
  // phase cycle so GameSurface unmounts (closing the current room) and
  // remounts cleanly with the new `roomNameOverride` + `joinOptionsOverride`.
  // The 'connecting' beat is what the player sees as the loading spinner.
  // NO transit machinery: no spool-up, no neighbour-only check — the
  // player explicitly picked a hull they own and wants to fly it.
  const pendingShipSwap = useUIStore((s) => s.pendingShipSwap);
  const setPendingShipSwap = useUIStore((s) => s.setPendingShipSwap);
  const setCurrentSectorKey = useUIStore((s) => s.setCurrentSectorKey);
  useEffect(() => {
    if (!pendingShipSwap) return;
    const { shipId, sectorKey } = pendingShipSwap;
    logEvent('ship_swap_dispatch', { shipId, sectorKey, fromPhase: phase });
    // Update room overrides before the phase flip so when GameSurface
    // remounts it sees the new values immediately.
    setRoomNameOverride(`galaxy-${sectorKey}`);
    setJoinOptionsOverride({ shipId });
    // Clear the current-sector chrome so the brief galaxy-map glimpse
    // (if any) and post-arrival HUD start from the new sector identity.
    setCurrentSectorKey(null);
    // game → connecting unmounts GameSurface (which cleans up the old
    // Colyseus room). After a microtask the connecting → game flip
    // remounts GameSurface, triggering a fresh joinOrCreate with the
    // shipId override.
    setPhase('connecting');
    const timer = setTimeout(() => {
      setPhase('game');
      setPendingShipSwap(null);
      logEvent('ship_swap_completed', { shipId, sectorKey });
    }, 200);
    return () => clearTimeout(timer);
    // Note: `phase` is intentionally omitted from the deps list — it
    // changes inside this effect (setPhase('connecting' then 'game'))
    // which would re-trigger; the value at dispatch time is sufficient.
  }, [pendingShipSwap, setPhase, setPendingShipSwap, setCurrentSectorKey]);

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

  // Compute the per-phase content as a variable so we can wrap the whole
  // tree in a single LayoutProvider + render the FullscreenToggle once.
  // The toggle previously only appeared during the 'game' phase, which meant
  // mobile users couldn't enter fullscreen from the meta landing, login, or
  // galaxy-map screens. Now it persists everywhere on touch devices.
  let phaseContent: JSX.Element;
  if (phase === 'game') {
    phaseContent = (
      <>
        <AppHeader
          onLoginClick={() => setPhase('auth')}
          onProfileClick={() => setProfileOpen(true)}
          onSettingsClick={openSettings}
        />
        <GameSurface roomNameOverride={roomNameOverride} joinOptionsOverride={joinOptionsOverride} />
        <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
        <SettingsModal open={settingsOpen} onClose={closeSettings} />
      </>
    );
  } else if (phase === 'local') {
    phaseContent = <LocalSurface />;
  } else if (phase === 'meta') {
    phaseContent = (
      <>
        <AppHeader
          onLoginClick={() => setPhase('auth')}
          onProfileClick={() => setProfileOpen(true)}
          onSettingsClick={openSettings}
        />
        <MetaLandingScreen
          onJoin={handleJoinFromMeta}
          onSelectLocal={user ? handleSelectLocal : undefined}
        />
        <MobileAvatarBadge onClick={() => setProfileOpen(true)} />
        <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
        <SettingsModal open={settingsOpen} onClose={closeSettings} />
      </>
    );
  } else if (phase === 'auth') {
    phaseContent = (
      <>
        <AppHeader
          onLoginClick={() => {}}
          onProfileClick={() => setProfileOpen(true)}
          onSettingsClick={openSettings}
        />
        <LoginPage onSuccess={handleAuthSuccess} onSkip={handleAuthSuccess} />
        <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
        <SettingsModal open={settingsOpen} onClose={closeSettings} />
      </>
    );
  } else {
    // 'galaxy-map' (or transient 'connecting') — visual hex galaxy.
    phaseContent = (
      <>
        <AppHeader
          onLoginClick={() => setPhase('auth')}
          onProfileClick={() => setProfileOpen(true)}
          onSettingsClick={openSettings}
        />
        {phase === 'connecting' ? (
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100vh',
              pt: 'var(--app-bar-h, 48px)',
              bgcolor: '#05070f',
            }}
          >
            <CircularProgress sx={{ color: '#00ff88' }} />
          </Box>
        ) : (
          <GalaxyOverviewScreen
            mode="spawn"
            /* activeLimboSectorKey omitted on purpose so the screen runs its
               own /dev/limbo lookup and renders the saved-ship card. */
            onSelectRoom={handleSelectRoom}
            onSpawnExistingShip={handleSpawnExistingShip}
            onSpawnNewShip={handleSpawnNewShip}
            onSelectLocal={handleSelectLocal}
          />
        )}
        <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
        <SettingsModal open={settingsOpen} onClose={closeSettings} />
      </>
    );
  }

  return (
    <ErrorBoundary>
      <LayoutProvider>
        {phaseContent}
        <TopRightToolbar />
      </LayoutProvider>
    </ErrorBoundary>
  );
}
