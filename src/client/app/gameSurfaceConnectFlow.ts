/**
 * The async IIFE inside the GameSurface bootstrap useEffect — pulled
 * into a standalone function so the useEffect reads as
 * "init keyboard / new gameClient / start the connect flow / wire
 * cleanup" instead of being a 100-line monolith.
 *
 * Sequence: await renderer.init (timed) → curtain-on while gameReady
 * is false → install the galaxy overlay → resolve fpscap URL override
 * → kick the RAF loop → resolve JoinSpec → gameClient.connect →
 * publish the prettyName.
 *
 * `isDisposed` is the StrictMode escape hatch: if cleanup ran while
 * we were awaiting `renderer.init`, we tear down the just-initialised
 * renderer and exit (the second StrictMode mount will take over).
 */

import { logEvent } from '../debug/ClientLogger';
import { useUIStore } from '../state/store';
import { loadStoredPlayerId, persistPlayerId } from '../identity/token';
import { DEFAULT_MIN_FRAME_INTERVAL_MS } from '../perf/frameRateCap';
import { createGameRafLoop } from './gameRafLoop';
import { installGalaxyOverlay } from './galaxyOverlay';
import { buildJoinSpec } from './gameSurfaceBootstrap';
import type { IRenderer } from '@core/contracts/IRenderer';
import type { ColyseusGameClient } from '../net/ColyseusClient';
import type { Keyboard } from '../input/Keyboard';
import type { TouchInput } from '../input/TouchInput';
import type { GalaxyMapLayer } from '../render/galaxy/GalaxyMapLayer';
import type { GalaxyLayerMode } from '../render/galaxy/galaxyLayerDecisions';
import type { ConnectionStatus } from '../state/store';
import type { MutableRefObject } from 'react';
import { SERVER_URL } from './serverUrl';

export interface ConnectFlowOpts {
  el: HTMLDivElement;
  renderer: IRenderer;
  useWorker: boolean;
  gameClient: ColyseusGameClient;
  keyboard: Keyboard;
  touchInput: TouchInput | null;
  phaseEnterPerfNow: number;
  isDisposed: () => boolean;
  galaxyLayerRef: MutableRefObject<GalaxyMapLayer | null>;
  animFrameRef: MutableRefObject<number>;
  roomNameOverride: string | undefined;
  joinOptionsOverride: Record<string, unknown> | undefined;
  onEngageTransit: (key: string) => void;
  onConnectionStatus: (status: ConnectionStatus) => void;
  onPlayerId: (id: string) => void;
  onSectorName: (name: string) => void;
  /**
   * `connect` (default) — the gameplay path: init renderer, kick the
   * sim RAF loop, join a Colyseus room. `idle` — the persistent
   * galaxy-picker canvas (single-canvas refactor): init the renderer and
   * install the galaxy overlay (in `overlayMode`), then STOP — no sim
   * loop, no room join. The galaxy layer renders + pulses on the
   * renderer's own ticker. The flip from idle → connect happens by
   * re-running the bootstrap in `connect` mode once a sector is chosen.
   */
  surfaceMode?: 'connect' | 'idle';
  /** Galaxy-overlay mode passed to `installGalaxyOverlay`. Default `overlay`. */
  overlayMode?: GalaxyLayerMode;
  /** Selector-mode tap handler (the spawn picker). Used when `overlayMode === 'selector'`. */
  onSelectorPick?: (sectorKey: string) => void;
}

export async function runGameSurfaceConnectFlow(opts: ConnectFlowOpts): Promise<void> {
  const {
    el, renderer, useWorker, gameClient, keyboard, touchInput,
    phaseEnterPerfNow, isDisposed, galaxyLayerRef, animFrameRef,
    roomNameOverride, joinOptionsOverride, onEngageTransit,
    onConnectionStatus, onPlayerId, onSectorName,
    surfaceMode = 'connect', overlayMode = 'overlay', onSelectorPick,
  } = opts;
  const idle = surfaceMode === 'idle';

  const rendererInitStartedAt = performance.now();
  await renderer.init(el);
  const rendererInitMs = performance.now() - rendererInitStartedAt;

  // StrictMode fires cleanup before the async init resolves. If disposal
  // happened while we were awaiting, tear down the just-initialised renderer
  // (which appended a canvas) and exit — the second mount will take over.
  if (isDisposed()) {
    renderer.dispose();
    return;
  }
  // Load curtain ON immediately — hides the canvas during the
  // join load period so the player doesn't see ship-at-(0,0)
  // ghost frames, partial mirror state, or rippled asteroid
  // bleed-through. The curtain is independent of the warp filter
  // chain (no spool/climax/burst on initial join — that envelope
  // is for inter-sector transit only, and is driven by the
  // transitState effect below). The curtain fades AND the
  // arrival flash fires when `gameReady` flips true.
  //
  // Idle (galaxy-picker) mode has no join load period, so the curtain
  // stays DOWN — the picker must be visible immediately.
  if (!idle && !useUIStore.getState().rendererFirstFrameRendered) {
    renderer.setLoadCurtain(true);
  }
  logEvent('renderer_init_complete', {
    rendererInitMs: Math.round(rendererInitMs),
    msFromPhaseEnter: Math.round(performance.now() - phaseEnterPerfNow),
  });

  // Galaxy overlay — `overlay` (in-game additive Map B) or `selector`
  // (the full-screen spawn picker on this persistent canvas). See
  // galaxyOverlay.ts for the worker-vs-DOM construction paths.
  galaxyLayerRef.current = installGalaxyOverlay({
    renderer,
    useWorker,
    el,
    onEngageTransit,
    mode: overlayMode,
    onSelectorPick,
  });

  // Idle galaxy-picker canvas: no simulation and no room. The galaxy
  // layer renders + pulses via its own ticker on the renderer's stage,
  // so we stop here — no sim RAF loop, no gameClient.connect. The flip
  // to a live game re-runs this flow in `connect` mode.
  if (idle) return;

  // Probe 3 (mobile-perf-investigation): `?fpscap=N` URL override
  // for DEFAULT_MIN_FRAME_INTERVAL_MS. See gameRafLoop.ts.
  const fpsCapParam = new URLSearchParams(window.location.search).get('fpscap');
  const fpsCapOverride = fpsCapParam !== null ? Math.max(0, parseFloat(fpsCapParam)) : null;
  const effectiveCapMs = fpsCapOverride !== null && !Number.isNaN(fpsCapOverride)
    ? fpsCapOverride
    : DEFAULT_MIN_FRAME_INTERVAL_MS;
  if (fpsCapOverride !== null) {
    logEvent('fps_cap_override', { fpsCapParam, effectiveCapMs });
  }
  const loop = createGameRafLoop({
    el,
    gameClient,
    renderer,
    useWorker,
    effectiveCapMs,
    phaseEnterPerfNow,
    animFrameRef,
    isDisposed,
  });
  animFrameRef.current = requestAnimationFrame(loop);

  const storedId = loadStoredPlayerId();
  const { roomName, extraJoinOptions, prettyName } = buildJoinSpec(roomNameOverride, joinOptionsOverride);

  await gameClient.connect(SERVER_URL, storedId, keyboard, {
    onConnectionStatus,
    onPlayerId: (id) => {
      persistPlayerId(id);
      onPlayerId(id);
    },
    // Effects subsystem (M9 — plan wiggly-puppy). Wipe the renderer's
    // per-entity emitters + in-flight bursts on sector handoff so dead-
    // entity-id state doesn't leak across the warp gap. The diff-against-
    // empty-mirror passes in syncEngineContinuousEffects /
    // syncShieldAuraEffects would unregister continuous emitters
    // naturally on the destination's first frame, but in-flight bursts
    // (destruction particles, impact sparks) live at source-sector
    // world coords and would render in the wrong place — so we wipe.
    onSectorHandoff: () => renderer.resetEffectsForSectorHandoff(),
  }, roomName, extraJoinOptions, touchInput ?? undefined);

  onSectorName(prettyName);
}
