/**
 * Frame passes 6-7 of `PixiRenderer.update()`: end-of-frame feedback and the
 * effects tick — lifted out of `PixiRenderer` (god-file split, slice 7).
 *
 * `writeFrameFeedback` fills `RendererFeedback` (mount counts, radar / damage
 * counts, view, first-frame and art readiness), the F1 frame markers and the
 * warp FX; `tickFrameEffects` runs engine / shield FX and the effects service
 * tick, after every sprite pass. Both read the pooled frame ctx
 * (`frameCtx.ts`) and allocate nothing (#14).
 */

import type { RenderMirror } from '@core/contracts/IRenderer';
import { updateWarpFx } from './warpFxUpdater.js';
import { updateEngineShieldFx } from './engineShieldFxUpdater.js';
import { shouldLatchFirstFrame } from '../firstFrameLatch.js';
import type { RendererFrameCtx } from './frameCtx.js';

/** RendererFeedback, F1 frame markers and the warp / spool FX. */
export function writeFrameFeedback(mirror: RenderMirror, ctx: RendererFrameCtx): void {
  const r = ctx.r;
  // ---------- RendererFeedback (end-of-frame, main-thread readable) ----------
  // Populate the feedback struct that main reads after update() returns.
  // Today this is sync-mutate (renderer and main share a process).
  // Phase 4 of the worker migration will replace this with a FEEDBACK
  // postMessage from the renderer worker; the contract surface stays
  // the same (caller does `renderer.getFeedback()`).
  // Every ship, parked hulls included (R2.32: the worker-boundary probe
  // asserts a parked hull's barrels render; covers ACTIVE + LINGERING, #17).
  r.feedback.mountCounts.clear();
  for (const shipId of mirror.ships.keys()) {
    const count = r.mountVisuals.mountCountForShip(shipId);
    if (count > 0) r.feedback.mountCounts.set(shipId, count);
  }
  r.feedback.haloArrowCount = r.halo.getDebugVisibleArrowCount();
  r.feedback.damageNumberActiveCount = r.hudCtx.damageNumbers?.getActiveCount() ?? 0;
  const vb = r.camera.visibleBoundsInto(ctx.swarmViewScratch); // Pixi space: y flips back to game
  r.feedback.viewX = (vb[0]! + vb[2]!) / 2; r.feedback.viewY = -(vb[1]! + vb[3]!) / 2; r.feedback.viewHalf = Math.max(vb[2]! - vb[0]!, vb[3]! - vb[1]!) / 2;
  // Join-render readiness signal: latch true once we've painted a frame the
  // player can see. Piloting → require the LOCAL player's own ship in the
  // mirror (not just any remote ship). SPECTATING → there is no own ship, so a
  // painted frame of the sector IS the signal (the shipless-spectator join-hang
  // fix — Equinox Phase-5 audit). Decision is pure + unit-locked
  // (`firstFrameLatch.ts`), per the Phase A3 extract-renderer-decisions rule.
  if (shouldLatchFirstFrame(
        r.feedback.firstFrameRendered,
        mirror.localPlayerId,
        mirror.localPlayerId !== null && mirror.ships.has(mirror.localPlayerId),
        r.spectator,
      )) {
    r.feedback.firstFrameRendered = true;
  }
  // Art readiness: nothing on screen still waiting for its Machined art.
  // Pre-bound callback + a field flag, so no per-frame allocation (#14).
  if (r.artCtx.art === null) {
    r.feedback.artReady = true;
  } else {
    ctx.artPendingSeen = false;
    r.artCtx.handles.forEach(ctx.noteArtPending);
    r.feedback.artReady = r.feedback.firstFrameRendered && !ctx.artPendingSeen;
    // The pilot's own ship bakes first (once per handle).
    const own = mirror.localPlayerId ? r.artCtx.handles.get(mirror.localPlayerId) : undefined;
    if (own && own.state === 'pending' && own.key !== ctx.prioritizedArtKey) {
      ctx.prioritizedArtKey = own.key;
      r.artCtx.art.prioritize(own);
    }
  }

  // ---------- F1 frame markers (end-of-frame, worker→main diag) ----------
  // Fold in the grid label-churn split that `BackgroundGrid.update()`
  // recorded earlier this frame (called at ~L1310 via
  // `r.backgroundGrid?.update(r.camera)`). `warpTickMs` is
  // written by the separate `LoadCurtain` ticker callback. `rendererUpdateMs`
  // closes the bracket opened at method entry. The worker posts these only when diagnostics are on.
  const grid = r.backgroundGrid?.lastFrameMarkers;
  if (grid) {
    r.frameMarkers.gridLabelSpecMs = grid.labelSpecMs;
    r.frameMarkers.gridTextCreateMs = grid.textCreateMs;
    r.frameMarkers.gridCleanupMs = grid.cleanupMs;
    r.frameMarkers.gridLabelCount = grid.labelCount;
  } else {
    r.frameMarkers.gridLabelSpecMs = 0;
    r.frameMarkers.gridTextCreateMs = 0;
    r.frameMarkers.gridCleanupMs = 0;
    r.frameMarkers.gridLabelCount = 0;
  }
  r.frameMarkers.spriteCount = r.sprites.size;
  // Warp / spool FX: see pixi/warpFxUpdater.ts (ctx pooled; camera scale per frame).
  r.warpFxCtx.cameraScale = r.world.scale.x;
  updateWarpFx(mirror, r.warpFxCtx);
}

/** Engine / shield FX and the effects service tick (after every sprite pass). */
export function tickFrameEffects(mirror: RenderMirror, ctx: RendererFrameCtx): void {
  const r = ctx.r;
  // Effects subsystem tick. MUST run AFTER all sprite updates so per-
  // entity effects (shield aura, engine emitters in later milestones)
  // read the one-pose-per-frame state the sprite updaters just wrote
  // (src/client/CLAUDE.md "Drones are PURE snapshot-interpolated"
  // section). dtMs = wall-clock since last tick; effects use it for
  // particle lifetime + budget EMA.
  if (r.effects) {
    // Engine continuous emitters — drive from mirror.boostingShips /
    // thrustingShips Sets (M5 of plan wiggly-puppy). Set diff per frame
    // → setContinuous on transitions only (no-op on identical state).
    // See pixi/engineShieldFxUpdater.ts; the shield gate is shared with beams + hit FX.
    r.engineShieldFxCtx.effects = r.effects;
    r.engineShieldFxCtx.fxShieldsOn = r.hitEventCtx.fxShieldsOn;
    updateEngineShieldFx(mirror, r.engineShieldFxCtx);

    const nowMs = r.fxNow();
    const dtMs = ctx.lastEffectsTickNowMs > 0 ? nowMs - ctx.lastEffectsTickNowMs : 16.67;
    // M9: feed the budget the PREVIOUS frame's rendererUpdateMs
    // (current frame's value isn't set until line ~1062). Single-frame
    // lag is negligible vs the 500 ms budget hysteresis hold.
    r.effects.tick(nowMs, dtMs, r.frameMarkers.rendererUpdateMs);
    ctx.lastEffectsTickNowMs = nowMs;
    // Drawn-artefact signal for the worker-boundary lingering-aura lock
    // (P3.12 / WS-C3) — read AFTER tick(), which sets each ring's visibility.
    r.feedback.shieldRingVisibleCount = r.effects.shieldRingVisibleCount();
  } else {
    r.feedback.shieldRingVisibleCount = 0;
  }
}
