/**
 * Helpers for `App.tsx`'s GameSurface bootstrap useEffect.
 *
 * Three concerns, each small enough to inline but clearer as named
 * functions with their rationale next to them:
 *   - `selectRenderer` — the desktop-worker vs touch-main-thread
 *     decision (with `?worker=0|1` opt-outs)
 *   - `installProfileWindow` — `?profile=1` opens a bounded 60 s
 *     `console.profile()` so a chrome-remote-debugged phone can
 *     submit a real DevTools timeline alongside the diag capture
 *   - `buildJoinSpec` — URL-param parsing + extraJoinOptions
 *     assembly + roomName + prettyName resolution
 *
 * The bootstrap useEffect inlines these.
 */

import { PixiRenderer } from '../render/PixiRenderer.js';
import {
  WorkerRendererClient,
  supportsOffscreenRenderer,
} from '../render/worker/WorkerRendererClient.js';
import { isTouchDevice } from '../input/TouchInput.js';
import { getSector } from '@core/galaxy/galaxy';
import { logEvent } from '../debug/ClientLogger.js';
import type { IRenderer } from '@core/contracts/IRenderer';

/**
 * Renderer-path selection (2026-05-22, mobile-perf-reconciliation).
 *
 * Non-touch + OffscreenCanvas-capable → worker-backed renderer
 * (frees main-thread CDP budget for React + drawer animations).
 *
 * Touch → main-thread PixiRenderer. On high-DPR Android the worker
 * IPC path produces ~110 ms tail-latency stalls; the 2026-05-22
 * smoke pair showed a 19× reduction in `raf_gap > 100 ms` events
 * after switching off the worker on the same device.
 *
 * `?worker=1` forces worker (A/B diagnosis); `?worker=0` forces
 * main-thread (non-touch verification of the mobile path).
 */
export function selectRenderer(): { renderer: IRenderer; useWorker: boolean; isTouch: boolean; workerParam: string | null } {
  const workerParam = new URLSearchParams(window.location.search).get('worker');
  const isTouch = isTouchDevice();
  const useWorker =
    workerParam === '1'
      ? supportsOffscreenRenderer()
      : workerParam === '0'
        ? false
        : !isTouch && supportsOffscreenRenderer();
  const renderer: IRenderer = useWorker ? new WorkerRendererClient() : new PixiRenderer();
  // Click-to-inspect (Item B) — DEV/E2E deterministic selection hook. Only the
  // main-thread PixiRenderer exposes `devSelectAtWorld` (the worker renderer is
  // off-thread); E2E specs run `?worker=0` to use it. Mirrors __eqxGalaxyPick.
  // Guarded by webdriver/DEV so it never ships a live hook to real players.
  if (
    renderer instanceof PixiRenderer
    && typeof navigator !== 'undefined'
    && (navigator as { webdriver?: boolean }).webdriver === true
  ) {
    (window as unknown as { __eqxSelectAtWorld?: (x: number, y: number) => string | null })
      .__eqxSelectAtWorld = (x, y) => renderer.devSelectAtWorld(x, y);
    // WS-10 (R2.4) — deterministic hover hook (peer of __eqxSelectAtWorld), so the
    // hover-outline E2E can hover an entity at its known world position without
    // camera-projection fragility. Runs the SAME pickEntityAt the pointer-move
    // hover uses.
    (window as unknown as { __eqxHoverAtWorld?: (x: number, y: number) => string | null })
      .__eqxHoverAtWorld = (x, y) => renderer.devHoverAtWorld(x, y);
  }
  logEvent('renderer_path_chosen', {
    useWorker,
    workerParam,
    isTouch,
    supportsOffscreenRenderer: supportsOffscreenRenderer(),
  });
  return { renderer, useWorker, isTouch, workerParam };
}

/**
 * Probe 0 (mobile-perf-investigation-review): `?profile=1` opens a
 * bounded `console.profile()` window. Auto-stops after 60 s so the
 * trace stays loadable — a 5-minute trace pegs DevTools on mobile.
 * The cheaper missed probe (vs NDJSON-only): distinguishes GC vs
 * frame-cap-artifact vs compositor-stall via flame-graph layer.
 */
export function installProfileWindow(): void {
  const profileParam = new URLSearchParams(window.location.search).get('profile');
  if (profileParam !== '1') return;
  try {
    console.profile('eqx-mobile-session');
    logEvent('profile_started', { autoStopMs: 60_000 });
    window.setTimeout(() => {
      try {
        console.profileEnd('eqx-mobile-session');
        logEvent('profile_ended', { reason: 'auto-stop' });
      } catch (e) {
        logEvent('profile_ended', { reason: 'error', error: String(e) });
      }
    }, 60_000);
  } catch (e) {
    logEvent('profile_started', { error: String(e) });
  }
}

export interface JoinSpec {
  roomName: string;
  extraJoinOptions: Record<string, unknown>;
  prettyName: string;
}

/**
 * URL-param-driven join spec.
 *
 * Room name precedence: `roomNameOverride` (lobby-chosen) → `?room=`
 * (engineering / legacy) → `?galaxy=...` (deep link) → default 'sector'.
 *
 * Join options pulled from URL params:
 *   - `spawnX` / `spawnY` (test-only spawn pose)
 *   - `initialHull` / `initialShield` (test-only HP overrides;
 *     server-side gated to testMode rooms — see JoinOptionsSchema)
 *   - `testId` (Colyseus `filterBy(['testId'])` per-test isolation)
 *   - `swarmCount` / `swarmRatio` / `swarmRadius` / `singleAsteroid`
 *     / `tickBurnMs` (Phase 5e soak tunables)
 *
 * `prettyName` is the HUD display name — looked up from a small
 * built-in table or, for `galaxy-${key}`, resolved from the galaxy
 * graph (`getSector(key).name`).
 */
export function buildJoinSpec(
  roomNameOverride: string | undefined,
  joinOptionsOverride: Record<string, unknown> | undefined,
): JoinSpec {
  const urlParams = new URLSearchParams(window.location.search);
  const galaxyParam = urlParams.get('galaxy');
  const roomName =
    roomNameOverride
    ?? urlParams.get('room')
    ?? (galaxyParam ? `galaxy-${galaxyParam}` : 'sector');
  const extraJoinOptions: Record<string, unknown> = { ...(joinOptionsOverride ?? {}) };
  if (urlParams.has('spawnX')) extraJoinOptions['spawnX'] = parseFloat(urlParams.get('spawnX')!);
  if (urlParams.has('spawnY')) extraJoinOptions['spawnY'] = parseFloat(urlParams.get('spawnY')!);
  if (urlParams.has('initialHull'))
    extraJoinOptions['initialHull'] = parseInt(urlParams.get('initialHull')!, 10);
  if (urlParams.has('initialShield'))
    extraJoinOptions['initialShield'] = parseInt(urlParams.get('initialShield')!, 10);
  // Test-only disconnect-linger TTL override (ms). Lets the linger E2E suite
  // observe despawn→return-to-pool in ~2 s. Server-side testMode-gated.
  if (urlParams.has('lingerMs'))
    extraJoinOptions['lingerMs'] = parseInt(urlParams.get('lingerMs')!, 10);
  // Structures plan (Phase 3/4) — override the grid pulse interval (ms) so the
  // mining/construction E2E can fast-forward the wall-clock pulse. testMode-gated.
  if (urlParams.has('structureGridPulseMs'))
    extraJoinOptions['structureGridPulseMs'] = parseInt(urlParams.get('structureGridPulseMs')!, 10);
  // plan: imperative-taco — `?startHostile=1` pre-marks every drone
  // hostile to the joining player at spawn, so a CDP allocation profile
  // hits steady-state combat without an IDLE→COMBAT warmup tail.
  // testMode-gated server-side; harmless on galaxy rooms.
  if (urlParams.has('startHostile'))
    extraJoinOptions['startHostile'] = urlParams.get('startHostile') === '1';
  if (urlParams.has('injectLeak'))
    extraJoinOptions['injectLeak'] = parseInt(urlParams.get('injectLeak')!, 10);
  if (urlParams.has('initialAngle'))
    extraJoinOptions['initialAngle'] = parseFloat(urlParams.get('initialAngle')!);
  if (urlParams.has('testId'))
    extraJoinOptions['testId'] = urlParams.get('testId')!;
  if (urlParams.has('swarmCount')) extraJoinOptions['swarmCount'] = parseInt(urlParams.get('swarmCount')!, 10);
  if (urlParams.has('swarmRatio')) extraJoinOptions['swarmRatio'] = parseFloat(urlParams.get('swarmRatio')!);
  if (urlParams.has('swarmRadius')) extraJoinOptions['swarmRadius'] = parseFloat(urlParams.get('swarmRadius')!);
  if (urlParams.has('singleAsteroid')) extraJoinOptions['singleAsteroid'] = urlParams.get('singleAsteroid') === '1';
  if (urlParams.has('tickBurnMs')) extraJoinOptions['tickBurnMs'] = parseFloat(urlParams.get('tickBurnMs')!);
  // E2E escape hatch (2026-05-27 — missile-frigate smoke): spawn directly
  // as a given ship kind without going through the ship-picker UI. The
  // server validates via `isShipKindId` and falls back to the catalogue
  // default on unknown ids, so a malformed value is harmless.
  if (urlParams.has('shipKind')) extraJoinOptions['shipKind'] = urlParams.get('shipKind')!;

  // Display name for the HUD.
  const builtin: Record<string, string> = {
    'sector': 'Sector Alpha',
    'test-sector': 'Test Sector',
    'feel-test': 'Feel Test (10)',
    'swarm-soak': 'Swarm Soak (500)',
    'swarm-tidi': 'Swarm TiDi (4000)',
    'swarm-tidi-burn': 'Swarm TiDi (burn 20 ms)',
  };
  let prettyName = builtin[roomName];
  if (!prettyName && roomName.startsWith('galaxy-')) {
    const sec = getSector(roomName.slice('galaxy-'.length));
    if (sec) prettyName = sec.name;
  }
  return { roomName, extraJoinOptions, prettyName: prettyName ?? roomName };
}
