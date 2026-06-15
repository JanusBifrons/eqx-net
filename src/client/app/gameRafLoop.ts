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
import { placementChosen, resetPlacementChosen } from '../structures/placementChosen.js';
import { commitChosenPlacement } from '../structures/structurePlacementClient.js';
import { sendSelectEntity, sendDeselectEntity } from '../net/selectionClient.js';
import { resetSelectionStats } from '../net/selectionStats.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';
import type { IRenderer } from '@core/contracts/IRenderer';

/** Click-to-inspect (Item B5) — last selection id the bridge published, so the
 *  RendererFeedback → Zustand mirror + server select/deselect sends fire ONLY on
 *  a transition (not every frame). Module-scope: the loop is a singleton per
 *  session and this never needs to survive a teardown (a fresh selection on the
 *  next session re-syncs naturally from null). */
let _lastPublishedSelectedId: string | null = null;

/** WS-10 (R2.5) — last drained `feedback.placementConfirmSeq`. The renderer bumps
 *  the seq on a DESKTOP mouse left-click during placement; when it changes we
 *  commit the placement at the chosen point + clear `placementKind`. A monotonic
 *  counter (not a one-shot bool) edge-detects cleanly across the worker FEEDBACK
 *  cache lag — the value only moves on a real click, so we commit once per click. */
let _lastPlacementConfirmSeq = 0;

// plan: imperative-taco — Playwright sets `navigator.webdriver=true`;
// a real player's browser leaves it undefined/false. The heavy E2E
// instrumentation in `writeE2EDataset` (JSON.stringify of shipPositions,
// swarmDetail, predStats, etc. every 5th frame) exists purely so specs
// can poll DOM state — production phones pay the allocation cost for
// no observer. Cached at module load: a single boolean read in the hot
// loop. The P1 hostile profile measured the per-5-frame slice at the
// rank-1 allocator's top (`gameRafLoop.loop` 55 KB / 6.8 %).
//
// 2026-06-01: `?noE2EDataset=1` URL escape lets specs that don't read
// the dataset (e.g. `phone-galaxy-stall-repro.spec.ts` reads via
// `window.__eqxLogs`) opt out of the per-5-frame JSON.stringify x 6
// dump under heavy combat. Measured saving: ~40 % of in-game loaf
// duration in the 35-hostile-drone repro.
function resolveE2EDatasetEnabled(): boolean {
  if (typeof navigator === 'undefined' || (navigator as { webdriver?: boolean }).webdriver !== true) {
    return false;
  }
  try {
    const q = typeof window !== 'undefined' && window.location?.search
      ? new URLSearchParams(window.location.search).get('noE2EDataset')
      : null;
    if (q === '1') return false;
  } catch {
    // window/URLSearchParams unavailable — fall through, keep enabled.
  }
  return true;
}
const E2E_DATASET_ENABLED: boolean = resolveE2EDatasetEnabled();

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
    // A blueprint ghost is up ⇒ we need renderer feedback in PRODUCTION too: the
    // Confirm banner reads the pointer-chosen world point + the banner anchors
    // over the ghost. The data-* placement surface in `writeE2EDataset` is
    // webdriver-only, so on a real phone Confirm used to read an empty dataset
    // and place ahead-of-ship (smoke 2026-06-07 capture kuytvy). This bridge is
    // NOT E2E-gated. `pendingPlacementPreview` is a cheap mirror flag and
    // placement is a rare, brief mode, so the extra getFeedback() is negligible.
    const placing = gameClient.mirror.pendingPlacementPreview != null;
    // Single batched renderer-feedback read per frame — when E2E wants the
    // dataset OR a placement is active. Skips getFeedback() entirely otherwise.
    const feedback = (writeE2E || placing) ? renderer.getFeedback() : null;
    if (placing && feedback) {
      placementChosen.worldX =
        typeof feedback.placementChosenWorldX === 'number' ? feedback.placementChosenWorldX : null;
      placementChosen.worldY =
        typeof feedback.placementChosenWorldY === 'number' ? feedback.placementChosenWorldY : null;
      placementChosen.stuck = feedback.placementStuck;
      // WS-10 (R2.5) — DESKTOP one-click place: the renderer bumped the confirm
      // seq on a mouse left-click. Commit at the chosen point (just written
      // above, so it's this click's point) via the SAME path the touch Confirm
      // banner uses, then clear `placementKind`. Edge-detect on the seq so a
      // single click commits exactly once even though the worker FEEDBACK cache
      // may report the same seq across a couple of RAFs.
      if (feedback.placementConfirmSeq !== _lastPlacementConfirmSeq) {
        _lastPlacementConfirmSeq = feedback.placementConfirmSeq;
        const kind = useUIStore.getState().placementKind;
        if (kind) {
          commitChosenPlacement(kind);
          useUIStore.getState().setPlacementKind(null);
        }
      }
      // Anchor the Confirm banner over the ghost's projected screen position.
      const psx = feedback.placementScreenX;
      const psy = feedback.placementScreenY;
      if (typeof psx === 'number' && typeof psy === 'number') {
        const banner = document.querySelector('[data-testid="placement-banner"]') as HTMLElement | null;
        if (banner) {
          banner.style.left = `${Math.max(8, Math.min(window.innerWidth - 8, psx))}px`;
          banner.style.top = `${Math.max(48, Math.min(window.innerHeight - 8, psy))}px`;
        }
      }
    } else if (placementChosen.worldX !== null || placementChosen.stuck) {
      resetPlacementChosen();
    }
    if (localShip && writeE2E && feedback) {
      el.dataset['shipX'] = localShip.x.toFixed(3);
      el.dataset['shipY'] = localShip.y.toFixed(3);
      el.dataset['shipAngle'] = localShip.angle.toFixed(4);
      el.dataset['mountCount'] = String(feedback.mountCounts.get(localId!) ?? 0);
    }
    if (writeE2E && feedback) {
      writeE2EDataset(el, gameClient, feedback, localId, localShip ?? null);
    }

    // ── Click-to-inspect selection bridge (Item B2/B3/B5) ──────────────────
    // The renderer owns the selection and publishes it on RendererFeedback.
    // Mirror TRANSITIONS (on change only) into Zustand (panel visibility) and
    // start/stop the server's ~5 Hz stats stream. `getFeedback()` is a zero-
    // alloc field return (the heavy E2E dataset cost is gated above), so this
    // per-frame read is cheap; the actual work fires only on a transition.
    const selFb = feedback ?? renderer.getFeedback();
    const selId = selFb.selectedPickId;
    if (selId !== _lastPublishedSelectedId) {
      _lastPublishedSelectedId = selId;
      const selKind = selFb.selectedPickKind;
      useUIStore.getState().setSelectedEntity(selId, selKind);
      resetSelectionStats(); // drop stale numbers across a selection change
      if (selId === null) {
        sendDeselectEntity();
      } else if (selKind === 'ship' || selKind === 'structure') {
        // Ship/structure use the server stats channel; drone reads the
        // mirror, so cancel any prior server stream when switching to them.
        sendSelectEntity(selId, selKind);
      } else {
        sendDeselectEntity();
      }
    }

    // ── WS-9 (R2.30) — world-anchored stats panel ──────────────────────────
    // Float the (position:fixed) EntityStatsPanel over the selected entity each
    // frame from the renderer's screen-projection (mirrors the placement banner).
    const ssx = selFb.selectionScreenX;
    const ssy = selFb.selectionScreenY;
    if (typeof ssx === 'number' && typeof ssy === 'number') {
      const panel = document.querySelector('[data-testid="entity-stats-panel"]') as HTMLElement | null;
      if (panel) {
        panel.style.left = `${Math.max(8, Math.min(window.innerWidth - 8, ssx))}px`;
        panel.style.top = `${Math.max(56, Math.min(window.innerHeight - 8, ssy))}px`;
      }
      if (writeE2E) {
        el.dataset['selectionScreenX'] = ssx.toFixed(1);
        el.dataset['selectionScreenY'] = ssy.toFixed(1);
      }
    } else if (writeE2E && el.dataset['selectionScreenX'] !== undefined) {
      delete el.dataset['selectionScreenX'];
      delete el.dataset['selectionScreenY'];
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
  // Lingering hulls (disconnected / displaced, isActive=false). These are
  // NOT in mirror.ships (they route to mirror.lingeringShips), so the linger
  // E2E suite reads this to assert a remote observer SEES a player's parked
  // hull. Keyed by shipInstanceId; carries the owning playerId.
  const lingerMap: Record<string, { x: number; y: number; ownerPlayerId: string }> = {};
  if (gameClient.mirror.lingeringShips) {
    for (const [id, l] of gameClient.mirror.lingeringShips) {
      lingerMap[id] = {
        x: parseFloat(l.x.toFixed(3)),
        y: parseFloat(l.y.toFixed(3)),
        ownerPlayerId: l.ownerPlayerId,
      };
    }
  }
  el.dataset['lingeringPositions'] = JSON.stringify(lingerMap);
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

  // ACTUAL drawn-beam origin (the BeamSpritePool sprite transform), as
  // opposed to the recompute above. This is the observable that catches
  // the render-cache detach bug (smoke handoff 2026-06-06, Issue 1 Bug #1):
  // data-beam-from-x/y tracks the live ship and stays glued even when the
  // drawn beam freezes, so only this attribute fails on a detach.
  const renderedFromX = feedback.liveBeamRenderedFromX;
  const renderedFromY = feedback.liveBeamRenderedFromY;
  if (typeof renderedFromX === 'number' && typeof renderedFromY === 'number') {
    el.dataset['beamRenderedFromX'] = renderedFromX.toFixed(3);
    el.dataset['beamRenderedFromY'] = renderedFromY.toFixed(3);
  } else {
    delete el.dataset['beamRenderedFromX'];
    delete el.dataset['beamRenderedFromY'];
  }

  // WS-4 Phase 4 (R2.27) — count of mining beams actually drawn in the
  // dedicated amber `_miningBeamPool` (the pool's liveCount). Published as
  // `data-mining-beam-count` so the structure-scenario E2E can assert the
  // Miner's beam renders distinctly (NOT the shared remote/live pool).
  el.dataset['miningBeamCount'] = String(feedback.miningBeamCount);

  // WS-10 (R2.4) — the entity the desktop pointer is hovering over (the lighter
  // HoverBracket outline target), so the hover-outline E2E can assert it tracks
  // the cursor. '' when over empty space / on touch. Renderer-owned; never
  // Zustand (#2 — it updates at pointer-move cadence).
  el.dataset['hoverPickId'] = feedback.hoveredPickId ?? '';

  // Structure placement confirm — world-anchored (smoke handoff 2026-06-06,
  // Issue 5). Move the (position:fixed) confirm banner to the renderer's
  // projected on-screen position of the blueprint ghost, so it sits over the
  // structure and ABOVE the thumb cluster (fixes the mobile occlusion).
  // Direct-DOM write — no per-frame React re-render (#2). The query is cheap
  // and only matches while placement mode is active (the banner is unmounted
  // otherwise).
  const placeX = feedback.placementScreenX;
  const placeY = feedback.placementScreenY;
  if (typeof placeX === 'number' && typeof placeY === 'number') {
    el.dataset['placementScreenX'] = placeX.toFixed(1);
    el.dataset['placementScreenY'] = placeY.toFixed(1);
    // The pointer-chosen GAME point the Confirm send uses (tap/drag-to-position
    // 2026-06-07). Published as data-attrs so the banner reads it on Confirm
    // without a per-frame React write (#2).
    if (typeof feedback.placementChosenWorldX === 'number' && typeof feedback.placementChosenWorldY === 'number') {
      el.dataset['placementWorldX'] = feedback.placementChosenWorldX.toFixed(2);
      el.dataset['placementWorldY'] = feedback.placementChosenWorldY.toFixed(2);
    }
    el.dataset['placementStuck'] = feedback.placementStuck ? '1' : '0';
    // Item C — would-connect count for the live connection-range preview, so
    // the banner / E2E can read how many hubs the ghost would link to here.
    el.dataset['placementPreviewConnCount'] = String(feedback.placementPreviewConnectionCount);
    // NB: the banner is anchored over the ghost in the PRODUCTION placement
    // bridge in `loop` (un-gated), not here — that block is webdriver-only.
  } else {
    delete el.dataset['placementScreenX'];
    delete el.dataset['placementScreenY'];
    delete el.dataset['placementWorldX'];
    delete el.dataset['placementWorldY'];
    delete el.dataset['placementStuck'];
    delete el.dataset['placementPreviewConnCount'];
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

  // Click-to-inspect selection (Item B2) — E2E observability for the selection
  // bracket. Reads the RENDERER's published selection (the real owner), NOT a
  // recompute. Webdriver-gated (E2E-only) like the rest of this dataset.
  if (feedback.selectedPickId !== null) {
    el.dataset['selectedPickId'] = feedback.selectedPickId;
    el.dataset['selectedPickKind'] = feedback.selectedPickKind ?? '';
  } else {
    delete el.dataset['selectedPickId'];
    delete el.dataset['selectedPickKind'];
  }
}
