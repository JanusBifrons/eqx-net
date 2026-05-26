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
import type { ConnectionStatus } from '../state/store';
import type { MutableRefObject } from 'react';

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? 'ws://localhost:2567';

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
}

export async function runGameSurfaceConnectFlow(opts: ConnectFlowOpts): Promise<void> {
  const {
    el, renderer, useWorker, gameClient, keyboard, touchInput,
    phaseEnterPerfNow, isDisposed, galaxyLayerRef, animFrameRef,
    roomNameOverride, joinOptionsOverride, onEngageTransit,
    onConnectionStatus, onPlayerId, onSectorName,
  } = opts;

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
  if (!useUIStore.getState().rendererFirstFrameRendered) {
    renderer.setLoadCurtain(true);
  }
  logEvent('renderer_init_complete', {
    rendererInitMs: Math.round(rendererInitMs),
    msFromPhaseEnter: Math.round(performance.now() - phaseEnterPerfNow),
  });

  // Map B (additive in-game galaxy overlay) — see galaxyOverlay.ts
  // for the worker-vs-DOM construction paths.
  galaxyLayerRef.current = installGalaxyOverlay({
    renderer,
    useWorker,
    el,
    onEngageTransit,
  });

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
  }, roomName, extraJoinOptions, touchInput ?? undefined);

  onSectorName(prettyName);
}
