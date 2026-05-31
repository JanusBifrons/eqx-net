/**
 * Per-RAF game loop body extracted from `App.tsx`'s GameSurface
 * bootstrap useEffect.
 *
 * Drives:
 *   1. `gameClient.tickPhysics(deltaMs)` — wall-clock-anchored input loop
 *   2. `gameClient.updateMirror()` — pose + HUD dispatch
 *   3. `renderer.update(mirror)` — sprites + UI overlays (gated to
 *      every-2nd-RAF in worker mode to halve postMessage marshaling)
 *   4. Per-frame trigger consumption (`consumeOneFrameTriggers`)
 *   5. Transit instrumentation frames (post-curtain-drop ~40-frame burst)
 *   6. Pixi-first-frame join-render latch
 *   7. E2E `data-*` attribute writes (throttled to every 5th frame so
 *      Playwright's stable-click-target detection isn't blocked by
 *      21+ DOM mutations per frame including JSON.stringify calls)
 *   8. `rafWork` diagnostic per-phase timing
 *
 * Internal 60 Hz work-loop cap: skips alternate RAFs on 90/120 Hz
 * displays via `shouldSkipFrame`, leaving `lastFrameTime` stale so the
 * next RAF reflects the full wall-clock gap. See `src/client/CLAUDE.md`
 * "Internal work-loop cap" — the rule is enforced by the early-return
 * BEFORE `lastFrameTime = now`.
 */

import { consumeOneFrameTriggers } from '../render/perFrameTriggers.js';
import { shouldSkipFrame } from '../perf/frameRateCap.js';
import { logEvent, isFullDiagMode } from '../debug/ClientLogger.js';
import {
  useUIStore,
  computeBootstrapReadyFromState,
  computeIsLoadingActive,
} from '../state/store.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';
import type { IRenderer } from '@core/contracts/IRenderer';

// plan: imperative-taco — Playwright sets `navigator.webdriver=true`;
// a real player's browser leaves it undefined/false. The heavy E2E
// instrumentation in `writeE2EDataset` (JSON.stringify of shipPositions,
// swarmDetail, predStats, etc. every 5th frame) exists purely so specs
// can poll DOM state — production phones pay the allocation cost for
// no observer. Cached at module load: a single boolean read in the hot
// loop. The P1 hostile profile measured the per-5-frame slice at the
// rank-1 allocator's top (`gameRafLoop.loop` 55 KB / 6.8 %).
const E2E_DATASET_ENABLED: boolean =
  typeof navigator !== 'undefined' && (navigator as { webdriver?: boolean }).webdriver === true;

export interface GameRafLoopDeps {
  /** The DOM container the renderer was attached to (data-* writes target it). */
  el: HTMLElement;
  /** Live game client. */
  gameClient: ColyseusGameClient;
  /** Pixi or worker renderer instance. */
  renderer: IRenderer;
  /** True when the worker-backed renderer is active. Halves render cadence. */
  useWorker: boolean;
  /** `DEFAULT_MIN_FRAME_INTERVAL_MS` or the `?fpscap=N` override. */
  effectiveCapMs: number;
  /** Wall-clock anchor for the join-render diagnostic. */
  phaseEnterPerfNow: number;
  /** Animation-frame handle reference — written every loop iteration. */
  animFrameRef: { current: number };
  /** True when GameSurface is unmounting — loop short-circuits. */
  isDisposed: () => boolean;
}

/**
 * Build the RAF loop callback. Returns a function suitable for the
 * first `requestAnimationFrame(loop)` call; the loop self-rebinds via
 * `animFrameRef.current = requestAnimationFrame(loop)` until `isDisposed()`
 * returns true.
 */
export function createGameRafLoop(deps: GameRafLoopDeps): (now: number) => void {
  const { el, gameClient, renderer, useWorker, effectiveCapMs, phaseEnterPerfNow, animFrameRef, isDisposed } = deps;

  let lastFrameTime = 0;
  let frameCounter = 0;
  let workerUpdateCounter = 0;
  let firstFramePixiLogged = false;

  const loop = (now: number): void => {
    if (isDisposed()) return;

    // Plan: crispy-kazoo, Commit 2 — synchronised warp-in handshake.
    // Fire `sendClientReady` once the bootstrap gates all flip true.
    // The method itself is idempotent (the Zustand `clientReadySent`
    // flag short-circuits a second call). This check sits BEFORE the
    // cap / pause early-returns so the handshake completes even when
    // game-work is skipped — loading is exactly when bootstrap-ready
    // flips, so the trigger must run during the pause.
    const ui = useUIStore.getState();
    if (!ui.clientReadySent && computeBootstrapReadyFromState(ui)) {
      gameClient.sendClientReady();
    }

    // Plan: crispy-kazoo, Commit 4/8 — pause boundary.
    // During loading (curtain up): skip the INPUT + PHYSICS step
    // (`tickPhysics`) so input is gated and the predWorld doesn't drift
    // ahead of the server. KEEP `tickInbound` + `updateMirror` +
    // `renderer.update` running so:
    //   1. Snapshots can DRAIN (tickInbound → processPendingSnapshot →
    //      handleSnapshot → firstSnapshotApplied=true).
    //   2. firstFrameRendered can flip (renderer.update paints sprites).
    // Skipping either creates a circular dependency where bootstrap-
    // ready can never flip true → loading-active stays true → ...
    // The Pixi ticker independently drives the curtain animation; this
    // loop drives snapshot drain + sprite positions + the bootstrap
    // gate latches.
    const isLoadingActive = computeIsLoadingActive(ui);

    const isFirstFrame = lastFrameTime === 0;
    const deltaMs = isFirstFrame ? 1000 / 60 : now - lastFrameTime;
    // Internal 60 Hz work-loop cap. On 90/120 Hz native displays we
    // skip alternate RAFs and leave `lastFrameTime` stale so the next
    // RAF's `deltaMs` reflects the full wall-clock gap.
    if (shouldSkipFrame(deltaMs, effectiveCapMs, isFirstFrame)) {
      animFrameRef.current = requestAnimationFrame(loop);
      return;
    }
    lastFrameTime = now;

    // Plan: crispy-kazoo, Commit 8 — inbound-message drain ALWAYS runs
    // (incl. during loading). DC raw-bytes decode + Colyseus state-diff
    // hybrid drain + snapshot coalescer drain — these are the message-
    // arrival paths the bootstrap gates depend on (firstSnapshotApplied).
    gameClient.tickInbound(deltaMs);

    // Probe 1 (mobile-perf-investigation): per-RAF work breakdown.
    const physicsStart = performance.now();
    // Plan: crispy-kazoo, Commit 8 — gate ONLY `tickPhysics` during
    // loading. Input is already zero'd by Keyboard/TouchInput
    // setEnabled(false) so a runaway-input concern is already covered;
    // skipping the physics step here additionally prevents predWorld
    // drift during the curtain window.
    if (!isLoadingActive) gameClient.tickPhysics(deltaMs);
    const mirrorStart = performance.now();
    gameClient.updateMirror();
    const renderStart = performance.now();
    const shouldRender = !useWorker || (++workerUpdateCounter % 2) === 0;
    if (shouldRender) renderer.update(gameClient.mirror);
    const renderEnd = performance.now();
    // plan: imperative-taco — gate the rafWork builder at the call site.
    // `logEvent` has an internal HIGH_VOLUME_TAGS early-return but by then
    // the caller has already paid for the `{...}` literal + 5 `toFixed(2)`
    // strings. The hot-path cost is one cached boolean read.
    if (isFullDiagMode()) {
      logEvent('rafWork', {
        physicsMs: parseFloat((mirrorStart - physicsStart).toFixed(2)),
        mirrorMs: parseFloat((renderStart - mirrorStart).toFixed(2)),
        renderMs: shouldRender ? parseFloat((renderEnd - renderStart).toFixed(2)) : 0,
        shouldRender,
        totalMs: parseFloat((renderEnd - physicsStart).toFixed(2)),
        deltaMs: parseFloat(deltaMs.toFixed(2)),
      });
    }

    // Clear one-frame triggers ONLY after the renderer has actually
    // consumed them. Gate on the same shouldRender condition.
    consumeOneFrameTriggers(gameClient.mirror, shouldRender);

    // F-transit-instrument — bounded post-reveal frame burst.
    if (gameClient.transitInstr.wantsFrame()) {
      const m = gameClient.mirror;
      const spriteCount =
        m.ships.size + (m.swarm?.size ?? 0) + (m.projectiles?.size ?? 0);
      gameClient.transitInstr.frame(deltaMs, spriteCount);
    }

    // Join-render readiness: latch the moment the renderer first
    // paints a frame. Drives gameReady + WarpScreen fade-out.
    if (!firstFramePixiLogged) {
      const fb = renderer.getFeedback();
      if (fb.firstFrameRendered) {
        firstFramePixiLogged = true;
        const lid = gameClient.mirror.localPlayerId;
        const localEntry = lid ? gameClient.mirror.ships.get(lid) : null;
        logEvent('pixi_first_frame', {
          msFromPhaseEnter: Math.round(performance.now() - phaseEnterPerfNow),
          shipsInMirror: gameClient.mirror.ships.size,
          hasLocal: lid !== null,
          localX: localEntry?.x ?? null,
          localY: localEntry?.y ?? null,
        });
        useUIStore.getState().setRendererFirstFrameRendered(true);
      }
    }

    const localId = gameClient.mirror.localPlayerId;
    const localShip = localId ? gameClient.mirror.ships.get(localId) : null;
    const writeDataset = (++frameCounter % 5) === 0;
    // plan: imperative-taco — the whole E2E dataset surface (cheap
    // single-field writes + heavy `writeE2EDataset` map/JSON.stringify)
    // exists purely so Playwright specs can poll DOM state. Production
    // phones leave `navigator.webdriver === undefined` and pay zero cost.
    // Each toFixed string + each dataset property mutation is a discrete
    // small allocation (a DOMStringMap stores property refs); skipping
    // them on prod halves the rank-1 allocator P1 named
    // (`gameRafLoop.loop` 55 KB / 6.8 %).
    const writeE2E = writeDataset && E2E_DATASET_ENABLED;
    // Single batched renderer-feedback read per frame — only when we
    // intend to use it (skips a `getFeedback()` call entirely in prod).
    const feedback = writeE2E ? renderer.getFeedback() : null;
    if (localShip && writeE2E && feedback) {
      el.dataset['shipX'] = localShip.x.toFixed(3);
      el.dataset['shipY'] = localShip.y.toFixed(3);
      el.dataset['shipAngle'] = localShip.angle.toFixed(4);
      el.dataset['mountCount'] = String(feedback.mountCounts.get(localId!) ?? 0);
    }
    if (writeE2E && feedback) {
      writeE2EDataset(el, gameClient, feedback, localId, localShip ?? null);
    }
    animFrameRef.current = requestAnimationFrame(loop);
  };

  return loop;
}

/**
 * E2E inspection surface — all the `data-*` attribute writes the
 * Playwright suite reads. Throttled to every 5th frame (12 Hz at 60 Hz
 * native) so the DOM mutation cost stays well below Playwright's
 * stable-click-target threshold.
 *
 * Reads from `gameClient.mirror` + `feedback` + `useUIStore.getState()`.
 * Mutates `el.dataset` in place.
 */
function writeE2EDataset(
  el: HTMLElement,
  gameClient: ColyseusGameClient,
  feedback: ReturnType<IRenderer['getFeedback']>,
  localId: string | null,
  localShip: { x: number; y: number; angle: number } | null,
): void {
  // Expose all ship positions for E2E cross-client position assertions.
  const posMap: Record<string, { x: number; y: number }> = {};
  for (const [id, s] of gameClient.mirror.ships) {
    posMap[id] = { x: parseFloat(s.x.toFixed(3)), y: parseFloat(s.y.toFixed(3)) };
  }
  el.dataset['shipPositions'] = JSON.stringify(posMap);
  el.dataset['localPlayerId'] = localId ?? '';
  el.dataset['predStats'] = JSON.stringify(gameClient.stats);
  // Combat state.
  const uiState = useUIStore.getState();
  el.dataset['hullPct'] = String(uiState.hullPct);
  el.dataset['shieldPct'] = String(uiState.shieldPct);
  el.dataset['sectorAlert'] = uiState.sectorAlert ?? '';
  // Phase 6 TiDi observables.
  el.dataset['clockRate'] = uiState.clockRate.toFixed(4);
  el.dataset['swarmSize'] = String(gameClient.mirror.swarm?.size ?? 0);
  el.dataset['projectileCount'] = String(gameClient.mirror.projectiles?.size ?? 0);
  el.dataset['haloArrowCount'] = String(feedback.haloArrowCount);

  // Multi-mount/turret refactor — flatten across mounts.
  const liveBeams = gameClient.mirror.liveBeams;
  const beamCount = liveBeams?.size ?? 0;
  el.dataset['beamActive'] = beamCount > 0 ? '1' : '0';
  el.dataset['beamCount']  = String(beamCount);
  if (liveBeams && beamCount > 0 && localShip) {
    const xs: string[] = [];
    const ys: string[] = [];
    const ds: string[] = [];
    for (const beam of liveBeams.values()) {
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

  // Remote lasers — Phase 2c per-mount flatten.
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

  // Phase 5e per-entity sleeping flags.
  if (gameClient.mirror.swarm) {
    const sleepMap: Record<string, boolean> = {};
    for (const [entityId, s] of gameClient.mirror.swarm) {
      sleepMap[String(entityId)] = !!s.sleeping;
    }
    el.dataset['swarmSleeping'] = JSON.stringify(sleepMap);
  } else {
    delete el.dataset['swarmSleeping'];
  }

  // Swarm positions for collision-stability assertions.
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
}
