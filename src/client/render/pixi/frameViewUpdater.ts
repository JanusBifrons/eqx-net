/**
 * Frame passes 3-5 of `PixiRenderer.update()`: beams, the camera and the
 * view layers — lifted out of `PixiRenderer` (god-file split, slice 7).
 *
 * `updateBeamsAndCamera` opens the shield frame, draws tractor / remote /
 * mining / live beams, frames the camera and the placement ghost;
 * `updateBackdrop` draws the sky, starfield and grid from this frame's camera;
 * `updateHudOverlays` runs damage numbers, hit events, HUD drains, aim
 * feedback, selection / hover, the cut field, labels, dying hulls, incoming
 * fire, the helm marker, fleet selection and the radar. All read the pooled
 * frame ctx (`frameCtx.ts`) and allocate nothing (#14).
 */

import type { RenderMirror } from '@core/contracts/IRenderer';
import { beginShieldFrame, updateHitEvents } from './hitEventUpdater.js';
import { updateBeams } from './beamUpdater.js';
import { updatePlacementGhost } from './placementGhostUpdater.js';
import { spawnDamageNumbers, updateHudDrains } from './hudDrainUpdater.js';
import { fillTractorBeams } from '../tractorBeams';
import { speedFxSampleInto } from '../camera/speedFxSample';
import { speedFxFullSpeed } from '../art/fx/depth.js';
import { updateArtShipLight } from '../art/shipArtSprites.js';
import type { RendererFrameCtx } from './frameCtx.js';

/** Shield frame, beams, camera follow and the placement ghost. */
export function updateBeamsAndCamera(mirror: RenderMirror, ctx: RendererFrameCtx): void {
  const r = ctx.r;
  // New shields (B5): open the frame here; beams and hits feed it below,
  // the shield sync closes it (pixi/hitEventUpdater.ts).
  beginShieldFrame(r.hitEventCtx);
  ctx.tractorViewCount = r.beamsDisabled || !r.tractorBeamPool ? 0 : fillTractorBeams(mirror, r.fxNow(), r.world.scale.x, r.tractorViews);
  r.tractorBeamPool?.setBeams(r.tractorViews, ctx.tractorViewCount, r.world.scale.x);
  // Remote, mining + live beams: see pixi/beamUpdater.ts. Ctx pooled to
  // `r.beamCtx` (built once in init); camera scale + shield gate per frame.
  r.beamCtx.cameraScale = r.world.scale.x;
  r.beamCtx.fxShieldsOn = r.hitEventCtx.fxShieldsOn;
  updateBeams(mirror, r.beamCtx);

  const local = mirror.localPlayerId ? r.sprites.get(mirror.localPlayerId) : null;
  ctx.speedFollowSprite = null;
  // Phase 4 WS-A1 — in spectator/construction mode the camera free-roams; do
  // NOT re-issue the local-ship follow (which would yank the view back / snap
  // to a ship that no longer exists). `setSpectator(true)` already detached
  // the follow target; the gameplay pointer path keeps panning/zooming it.
  ctx.speedFollowSprite = r.cameraDirector.updateFrame(mirror, local);

  // Structure placement ghost + confirm-UI projection: see pixi/placementGhostUpdater.ts.
  r.placementGhostCtx.spectator = r.spectator;
  updatePlacementGhost(mirror, r.placementGhostCtx);
}

/** Background layers (sky, starfield, grid) from this frame's camera. */
export function updateBackdrop(mirror: RenderMirror, ctx: RendererFrameCtx): void {
  const r = ctx.r;
  // Background layers — run AFTER moveCenter so they use this frame's
  // camera position (otherwise stars and grid lag by one frame).
  // Speed effects follow the pilot's own ship: full speed is its top speed
  // (the default kind's when spectating). Catalogue lookups are cached.
  const speedShip = mirror.localPlayerId ? mirror.ships.get(mirror.localPlayerId) : undefined;
  // Phase 4 travel state: in the empty middle of a trip the sky thins to deep
  // space (it fills back in as the ship flies into the new sector).
  r.backdrop?.setDeepSpace(mirror.travelDeep === true);
  r.backdrop?.setTravelHold(mirror.travelling === true);
  if (mirror.prewarmSector !== undefined) r.backdrop?.prewarm(mirror.prewarmSector);
  // Placing the ship on its approach into a new sector jumps the camera; the
  // sky is shifted back by the same amount so the stars carry on unbroken.
  // (Game space y up; Pixi y down.)
  const skyCam = ctx.skyCam;
  skyCam.center.x = r.camera.center.x - (mirror.travelJumpX ?? 0);
  skyCam.center.y = r.camera.center.y + (mirror.travelJumpY ?? 0);
  skyCam.scale.x = r.camera.scale.x;
  skyCam.screenWidth = r.camera.screenWidth;
  skyCam.screenHeight = r.camera.screenHeight;
  // The speed is measured from the followed ship's drawn pose at the frame
  // time it was drawn for, shifted like the sky (capital jitter, 2026-11-12).
  const followed = ctx.speedFollowSprite;
  const follow = ctx.speedFollowPose;
  if (followed) {
    follow.x = followed.x - (mirror.travelJumpX ?? 0);
    follow.y = followed.y + (mirror.travelJumpY ?? 0);
  }
  // Game time (time scale): the pose's wall frame time goes through the
  // presentation clock, so speed effects follow the sector's speed like every
  // other effect (at 1× `at(t)` is `t`).
  const speedFrameMs = mirror.frameTimeMs !== undefined ? r.fxClock.at(mirror.frameTimeMs) : undefined;
  // Command view's free camera is moved by hand, not flown: no speed effects.
  const speedSample = speedFxSampleInto(ctx.speedSample, followed ? follow : null, speedFrameMs, skyCam.center, r.fxNow(), r.spectator && !r.cameraDirector.isCameraScripted());
  const backdropOn = r.backdrop?.update(skyCam, r.fxNow(), speedFxFullSpeed(speedShip?.kind), speedSample) ?? false;
  // Speed effects (C3): the backdrop's eased speed asks the camera to zoom
  // out a little; applied on the camera's next tick (none while it's baking).
  r.camera.setSpeedZoom(backdropOn ? r.backdrop!.speedZoom() : 1);
  if (backdropOn) r.starfield?.setHidden(true);
  else r.starfield?.update(r.camera);
  r.backgroundGrid?.update(r.camera);
}

/** Combat feedback, selection / hover, labels, dying hulls and the radar. */
export function updateHudOverlays(mirror: RenderMirror, ctx: RendererFrameCtx): void {
  const r = ctx.r;
  // Damage numbers (spawn drain, before hit events): see pixi/hudDrainUpdater.ts.
  spawnDamageNumbers(mirror, r.hudCtx);
  // Hit events (impacts, wall hits, shield contacts): see pixi/hitEventUpdater.ts.
  r.hitEventCtx.effects = r.effects;
  updateHitEvents(mirror, r.hitEventCtx);
  // Damage-number cancels + tick, level-up icons, health bars: see pixi/hudDrainUpdater.ts.
  updateHudDrains(mirror, r.hudCtx);
  if (r.lockMarksVisible) r.aimFeedback?.update(mirror, r.camera.scale.x);
  else r.aimFeedback?.hide();

  // The selection's focus (Item B4; RTS Part A). The renderer owns
  // `_focusId`; the bracket resolves its live pose from the mirror each frame
  // (the markers themselves are drawn in the ticker, `drawFleetOverlay`). If
  // the focus has vanished from the mirror (despawned / left interest), clear
  // it so the panel + stats channel tear down.
  const focusPresent = r.selectionBracket?.resolveFocus(mirror, r.input._focusId) ?? false;
  if (!focusPresent && r.input._focusId !== null) {
    r.input._focusId = null;
    r.input._focusKind = null;
  }
  // Publish the current selection for the main thread → Zustand bridge.
  r.feedback.selectedPickId = r.input._focusId;
  r.feedback.selectedPickKind = r.input._focusKind;

  // WS-10 (R2.4) — hover outline. Suppress it on the already-SELECTED entity so
  // the two brackets never stack on the same target. If the hovered entity
  // vanished from the mirror, clear `_hoveredId`. Renderer-local id published
  // for the E2E bridge (data-hover-pick-id) — NEVER Zustand (#2).
  // Below the full HUD (showcase `?hud=`) the hover outline is not drawn.
  const hovered = r.input._hoveredId;
  const hoverTarget = hovered === null || hovered === r.input._focusId || r.input._selShips.has(hovered) || !r.lockMarksVisible ? null : hovered;
  if (hoverTarget !== null) {
    const stillHovered = r.hoverBracket?.update(mirror, hoverTarget) ?? false;
    if (!stillHovered) r.input._hoveredId = null;
  } else {
    r.hoverBracket?.update(mirror, null);
  }
  r.feedback.hoveredPickId = r.input._hoveredId;
  // WS-9 (R2.30) — project the bracket's above-entity point to SCREEN so the
  // stats box floats over the entity (any kind). Alloc-free toScreenInto (#14).
  const selWX = r.selectionBracket?.lastWorldX ?? null;
  const selWY = r.selectionBracket?.lastWorldY ?? null;
  if (selWX !== null && selWY !== null) {
    r.camera.toScreenInto(selWX, selWY, ctx.selScreenScratch);
    r.feedback.selectionScreenX = ctx.selScreenScratch.x;
    r.feedback.selectionScreenY = ctx.selScreenScratch.y;
  } else {
    r.feedback.selectionScreenX = null;
    r.feedback.selectionScreenY = null;
  }

  r.cutField.update(mirror, r.artCtx.sunAz, r.camera.scale.x, r.camera.visibleBoundsInto(ctx.swarmViewScratch)); // cut-field chunks + view (far-zoom tiles culled to it)

  // Phase 1 — name labels above remote ships and drones (skip self).
  r.labels?.update(mirror);

  // Dying capitals: hand over to wreck pieces drawn this frame, or give up
  // at the deadline; the rest keep their light frame at the last pose.
  r.dyingHulls.settle(r.fxNow());
  for (let i = 0; i < r.dyingHulls.heldCountNow(); i++) updateArtShipLight(r.artCtx, r.dyingHulls.heldSprite(i));

  // Halo arrows for off-screen POIs. Runs after moveCenter so the visibility
  // test uses this frame's viewport bounds, not last frame's. Incoming fire
  // first: the radar reads its groups for the off-screen chevron.
  r.incomingFire.update(mirror, r.fxNow()); // countdowns are game seconds
  // eslint-disable-next-line no-restricted-properties -- real time: the helm order marker is UI
  r.helmMarker.update(mirror, performance.now());
  r.input.updateFleetSelection(mirror);
  r.halo.update(mirror);
}
