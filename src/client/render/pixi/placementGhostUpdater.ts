/**
 * Structure placement ghost + its world→screen projection for the confirm UI
 * — lifted out of `PixiRenderer.update()` (god-file split, Phase 4).
 *
 * `updatePlacementGhost(mirror, ctx)` draws the plan as a bright hologram
 * (`StructureHologram`'s `ghost` look: cyan when clear, red where the
 * server's `placementRejection` would refuse it) at the previewed (or
 * pointer-chosen) pose, writes the placement feedback fields
 * and drives the input controller's placement state. The ctx is built once
 * by `createPlacementGhostCtx` (renderer construction); `init` sets `camera`
 * and `shipContainer`, and the caller writes `spectator` before each call.
 * Allocation: only the transient-UI debt noted inline (rebuild on a kind
 * change, `toScreen` while placing), moved unchanged.
 */

import type { Container } from 'pixi.js';
import type { RenderMirror, RendererFeedback } from '@core/contracts/IRenderer';
import { getStructureKind } from '@shared-types/structureKinds';
import type { Camera } from '../worker/Camera';
import { shouldCentreGhostOnActivate } from '../placementPointerDecision.js';
import type { RendererInputController } from './rendererInputController.js';
import type { GridObstacle } from '@core/structures/Grid';
import type { PlacementRejection } from '@core/structures/placementRules';
import { PlacementGhostVerdict, type GhostPose } from '../../structures/placementGhostVerdict.js';
import { StructureHologram } from './structureHologram.js';

export interface PlacementGhostCtx {
  /** Structure placement ghost (Issue 5) — the plan as a bright hologram
   *  (the unbuilt-blueprint hologram art, `ghost` look), built lazily and
   *  rebuilt only when the previewed kind changes. Lives in `shipContainer`
   *  (world space) so it pans/zooms with the structures. */
  placementGhost: StructureHologram | null;
  placementGhostKind: string | null;
  /** Set in `init`. */
  camera: Camera | null;
  shipContainer: Container | null;
  /** Structure style (`?restyle=`, set in `init` with the Machined art);
   *  absent = today's plan. The ghost draws the same style as the placed one. */
  structStyle?: string;
  /** Written by the caller each frame. */
  spectator: boolean;
  /** Game-clock now (`fxNow()`), written by the caller each frame: drives the
   *  ghost's scanner sweep and pulse. */
  nowMs: number;
  /** The rocks around the ghost, written by the caller each frame (the build
   *  preview's list, `ConnectorRenderer._previewObstacles`); null = none. */
  obstacles: readonly GridObstacle[] | null;
  /** The server's overlap rule for the ghost (red / green), and its pose scratch. */
  readonly verdict: PlacementGhostVerdict;
  readonly pose: GhostPose;
  readonly isTouch: boolean;
  readonly input: RendererInputController;
  readonly feedback: RendererFeedback;
}

export interface PlacementGhostCtxRefs {
  isTouch: boolean;
  input: RendererInputController;
  feedback: RendererFeedback;
}

/** Build the placement-ghost ctx once (renderer construction). */
export function createPlacementGhostCtx(refs: PlacementGhostCtxRefs): PlacementGhostCtx {
  return {
    placementGhost: null, placementGhostKind: null, camera: null, shipContainer: null, spectator: false, nowMs: 0,
    obstacles: null, verdict: new PlacementGhostVerdict(), pose: { kind: '', x: 0, y: 0, angle: 0 },
    isTouch: refs.isTouch, input: refs.input, feedback: refs.feedback,
  };
}

export function updatePlacementGhost(mirror: RenderMirror, ctx: PlacementGhostCtx): void {
  const camera = ctx.camera!;
  const shipContainer = ctx.shipContainer!;
  // Structure placement ghost + world→screen projection for the confirm
  // (smoke handoff 2026-06-06, Issue 5). Draw a translucent blueprint
  // silhouette at the previewed world pose and project that pose to screen
  // so the world-anchored confirm UI can sit on top of it. The ghost lives
  // in `shipContainer` (world space) so it pans/zooms with real structures;
  // Y-flip per the pixiY = -gameY convention. Only active during placement
  // mode (preview set), so the rebuild + `toScreen` alloc is transient UI,
  // never steady-state. (Phase-A3: the create/rebuild/hide branching could
  // move to a pure spriteUpdateDecisions helper if a 3rd preview type lands.)
  const preview = mirror.pendingPlacementPreview;
  // A "pending" preview is the dim post-Confirm ghost (playtest 2026-06-10
  // Issue 7): placement is DONE, so it must NOT capture pointers (the camera
  // pans again) and it draws at the SENT point, dimmer.
  const pendingGhost = preview != null && preview.pending === true;
  // Held = the live ghost still on the placement just sent (right after Place):
  // it keeps pointer capture but draws in the dim "sent" look with no verdict,
  // so it never reads red "too close" on its own new structure.
  const heldGhost = preview != null && !pendingGhost && preview.held === true;
  ctx.input._placementActive = preview != null && !pendingGhost;
  // P6.1 (touch only) — seed the ghost at SCREEN-CENTRE on placement-start so
  // it's visible instead of hidden under the speed-dial at the ahead-of-ship
  // pose. Park it (`following=false`) so the Confirm banner is ready at centre;
  // a tap/drag then repositions it. Desktop is gated out (hover-follow + the
  // ahead-of-ship preview is fine when the cursor is already on screen).
  if (preview && shouldCentreGhostOnActivate(ctx.isTouch, ctx.input._placementChosenX !== null, pendingGhost, ctx.spectator)) {
    const c = camera.center; // world coord (pixi-down) currently at screen centre
    ctx.input._placementChosenX = c.x;
    ctx.input._placementChosenY = -c.y; // game Y = -worldY
    // Park ONLY on touch (no hover → the Confirm banner waits at centre). On
    // DESKTOP (incl. desktop SPECTATOR, which also centre-seeds because there's
    // no ship to anchor) keep hover-follow ON so the ghost snaps to the cursor
    // on the first move — otherwise the spectator build ghost sat at centre and
    // never tracked the mouse (Equinox Phase-5 audit: "doesn't follow").
    ctx.input._placementFollowing = !ctx.isTouch;
  }
  if (preview) {
    if (!ctx.placementGhost || ctx.placementGhostKind !== preview.kind) {
      if (ctx.placementGhost) {
        shipContainer.removeChild(ctx.placementGhost);
        ctx.placementGhost.destroy({ children: true });
      }
      const radius = getStructureKind(preview.kind).radius;
      const g = new StructureHologram(preview.kind, radius, ctx.structStyle, 'ghost');
      shipContainer.addChild(g);
      ctx.placementGhost = g;
      ctx.placementGhostKind = preview.kind;
    }
    // Live ghost: draw at the pointer-chosen world point once positioned,
    // else the ahead-of-ship preview pose. Pending ghost: the SENT point.
    const gx = pendingGhost ? preview.x : (ctx.input._placementChosenX ?? preview.x);
    const gy = pendingGhost ? preview.y : (ctx.input._placementChosenY ?? preview.y);
    ctx.placementGhost.visible = true;
    ctx.placementGhost.x = gx;
    ctx.placementGhost.y = -gy; // Y-flip
    ctx.placementGhost.rotation = -preview.angle;
    // Build mirror (4B): flip in the local frame, then rotate (structureLocalToWorld).
    ctx.placementGhost.scale.x = preview.mirror === true ? -1 : 1;
    // Red / green before the click: the server's own overlap rule at the drawn
    // pose (structures, landing pads, rocks). The pending ghost is already sent.
    let rejection: PlacementRejection | null = null;
    if (!pendingGhost && !heldGhost && mirror.swarm) {
      const pose = ctx.pose;
      pose.kind = preview.kind; pose.x = gx; pose.y = gy; pose.angle = preview.angle; pose.mirror = preview.mirror === true;
      rejection = ctx.verdict.check(pose, mirror.structures, mirror.swarm, ctx.obstacles);
    }
    ctx.feedback.placementPreviewRejection = rejection;
    // Cyan when clear, red when blocked; the pending ghost is dimmer and still
    // so it reads as "sent, awaiting" vs positioning. Recolour only: no rebuild.
    ctx.placementGhost.updateGhost(rejection !== null, pendingGhost || heldGhost, ctx.nowMs);
    const screen = camera.toScreen(gx, -gy);
    ctx.feedback.placementScreenX = screen.x;
    ctx.feedback.placementScreenY = screen.y;
    ctx.feedback.placementChosenWorldX = gx;
    ctx.feedback.placementChosenWorldY = gy;
    ctx.feedback.placementStuck = !ctx.input._placementFollowing;
  } else {
    if (ctx.placementGhost) ctx.placementGhost.visible = false;
    ctx.feedback.placementScreenX = null;
    ctx.feedback.placementScreenY = null;
    ctx.feedback.placementChosenWorldX = null;
    ctx.feedback.placementChosenWorldY = null;
    ctx.feedback.placementStuck = false;
    ctx.feedback.placementPreviewRejection = null;
    // Reset for the next placement (start in follow mode, no chosen point).
    ctx.input._placementFollowing = true;
    ctx.input._placementChosenX = null;
    ctx.input._placementChosenY = null;
  }
}
