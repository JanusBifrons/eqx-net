/**
 * Pure warp-visual decision helpers. Extracted from the monolithic
 * `PixiRenderer.ts` per the god-file refactor plan
 * (`docs/plans/refactor-god-files.md`, commit 13). All three were
 * already documented as pure module-level functions with extensive
 * "do not regress" comments; this just moves them so they're greppable
 * without loading PixiRenderer.ts.
 *
 * Regression locks (which still resolve via `PixiRenderer.ts`
 * re-exports):
 *   - `PixiRenderer.warpDetach.test.ts` → shouldDetachWarpVisual
 *   - `PixiRenderer.warpBurst.test.ts`  → warpEventFiresBurst
 *   - `PixiRenderer.warpCenter.test.ts` → resolveWarpFilterCenter
 */

import type { WarpCenter } from '../worker/protocol.js';

/**
 * Decision: should the warp filter chain be detached from `app.stage`?
 *
 * Returns `true` only when every warp visual element is idle:
 *   - the burst + flash one-shot has finished (`burstStartedAt === 0`),
 *   - the fade-out tween is not in progress (`fadeStartedAt === 0`),
 *   - the fade scalar has reached zero (`intensity <= 0`).
 *
 * Called from two paths in `tickWarpShockwaves`: the fade-completion
 * branch (the burst might still be playing when fade ends) AND the
 * burst-completion branch (the fade might have ended earlier). If
 * either path forgets to tear down, the shockwaves / burst / zoom-blur /
 * bloom chain stays attached and burns 4+ no-op shader passes per
 * frame. On mid-range Android that's the difference between 60 fps
 * and a 100–200 ms raf_gap storm — see the 2026-05-15 mobile lag
 * report.
 */
export function shouldDetachWarpVisual(state: {
  burstStartedAt: number;
  fadeStartedAt: number;
  intensity: number;
}): boolean {
  return state.burstStartedAt === 0
    && state.fadeStartedAt === 0
    && state.intensity <= 0;
}

/**
 * Single source of truth for WHEN the warp burst+flash fires.
 *
 * Post Phase-G the load curtain rises at `transit_ready` (the
 * join-readiness re-arm flips `!gameReady` → loading=true) — BEFORE
 * the SPOOLING→IN_TRANSIT transition. So a burst fired from
 * `setWarpMode(false)` (the old spool-exit "climax") now ALWAYS fires
 * under the already-raised curtain: never a visible climax, and the
 * ~200 ms curtain-rise tween vs the fast room-swap lets it BLEED
 * through as a leaky flash, then the 5 s minimum-display floor, then
 * `triggerWarpIn`'s real arrival flash — a reordered double-flash with
 * a blackout between (on-device 2026-05-16, user smoke test). The
 * earlier theoretical "keep the climax, mask it" (Phase-G Option B)
 * was falsified on-device: a climax that is *always* occluded is pure
 * downside. Policy (Option A): exactly ONE warp flash per inter-sector
 * transit — the arrival reveal (`triggerWarpIn`, `'warp-in'`). The
 * warp-OUT (`setWarpMode(false)`, `'warp-mode-off'`) only fades the
 * filter chain out; the spool start (`setWarpMode(true)`,
 * `'warp-mode-on'`) ramps amplitude, no pulse.
 */
export type WarpBurstEvent = 'warp-in' | 'warp-mode-on' | 'warp-mode-off';
export function warpEventFiresBurst(event: WarpBurstEvent): boolean {
  return event === 'warp-in';
}

/**
 * #7 — should a REMOTE-warp ripple fire given the galaxy map's open state?
 *
 * The WarpFilterChain attaches to the shared `app.stage`, and the
 * `GalaxyMapLayer` (full-screen selector OR in-game additive overlay) is a child
 * of that SAME stage. A stage-level warp filter therefore distorts the galaxy
 * overlay the player is reading whenever a remote ship warps in/out — a ripple
 * bleeding across the hexes. Skip the visual entirely while the map is open; the
 * effect is purely cosmetic and the player isn't looking at the gameplay scene
 * anyway. Pure (mirrors `warpEventFiresBurst`); locked by
 * `PixiRenderer.warpGalaxyGate.test.ts`.
 */
export function shouldFireRemoteWarpVisual(state: { galaxyMapOpen: boolean }): boolean {
  return !state.galaxyMapOpen;
}

/**
 * Resolve the warp filter centre, in the renderer's screen-pixel
 * frame (the same frame `world.toGlobal` / `camera.screenWidth`
 * report — NO resolution rescale; see history note below).
 *
 * Coordinate-frame contract — the bug this encodes:
 *
 *   A `{kind:'world'}` warp anchor carries GAME-space coords (App.tsx
 *   reads them straight from `mirror.ships`, which is game-space, the
 *   same source the HUD grid readout uses). Game space is Y-UP. The
 *   renderer's `world` container is Pixi-space, Y-DOWN: every entity
 *   is drawn at `sprite.y = -ship.y`, and the camera follows the
 *   already-flipped sprite. So projecting a game-space anchor MUST
 *   negate Y first (`projectWorld(worldX, -worldY)`) — exactly the
 *   `-ship.y` flip every sprite gets. Without it the ripple lands at
 *   the *vertical mirror* of the ship (offset 2·shipY·scale); at a
 *   non-zero spawn Y it flings the pulse off-screen. The sandbox
 *   looked perfect because it only ever used screen-space / null
 *   anchors, which never hit the world projection (and so never the
 *   flip). 2026-05-15 smoke-test: "spawned in and it was off screen
 *   to the bottom right".
 *
 *   History: an earlier fix multiplied the result by
 *   `renderer.resolution`, theorising a HiDPI `uInputSize` mismatch.
 *   That was WRONG — the on-device evidence is decisive: the sandbox
 *   screen-centre warp was confirmed pixel-correct on the user's
 *   actual phone (DPR 3) with NO scaling, so the renderer's screen
 *   frame already matches the filter's `uInputSize` frame. The real
 *   defect was always the game→Pixi Y flip on the world-anchor path.
 *   Do not re-add a resolution multiply.
 *
 *   `entity` is the PRIMARY fix for the 2026-05-15 follow-up ("did
 *   the effect at the point when I started charging instead of where
 *   I actually was", and the user's architectural point: "what if a
 *   remote or bot ship is warping?"). The renderer re-resolves the
 *   anchor's `entityId` to that ship's LIVE sprite global position
 *   every frame and passes it as `entityGlobal`; the centre tracks
 *   the ship through the whole spool→climax→burst instead of freezing
 *   at the App.tsx capture instant. It is NOT local-specific — any
 *   ship id (local, remote, bot) resolves the same way. Because the
 *   live sprite is already correctly placed (`sprite.y = -ship.y`),
 *   this path needs no Y flip.
 *
 * `world` is now only for a genuinely point-anchored burst with NO
 * live entity to track — currently remote warp-OUT broadcasts, where
 * the ship has already despawned so a fixed "where it left from"
 * point IS correct (`pendingWarpEvents`). `screen` (sandbox click)
 * and `null` → screen-centre are already in Pixi screen space — no
 * flip, no scale.
 *
 * Pure + Pixi-free (mirrors the `shouldDetachWarpVisual` pattern):
 * `projectWorld` injects `world.toGlobal` and `entityGlobal` is
 * pre-resolved by the renderer (scene-graph access stays out of this
 * helper).
 */
export function resolveWarpFilterCenter(args: {
  warpCenter: WarpCenter | null;
  /** Pixi-space `world.toGlobal`. Called with ALREADY Y-flipped coords. */
  projectWorld: (pixiX: number, pixiY: number) => { x: number; y: number };
  /** Live screen-px position of the anchored entity's sprite, or null
   *  if it has no live sprite (despawned mid-warp / not spawned yet). */
  entityGlobal: { x: number; y: number } | null;
  screenW: number;
  screenH: number;
}): { x: number; y: number } {
  const screenCentre = { x: args.screenW * 0.5, y: args.screenH * 0.5 };
  if (args.warpCenter === null) return screenCentre;
  switch (args.warpCenter.kind) {
    case 'entity':
      // Live every frame — the renderer re-resolves `entityId` to that
      // ship's current sprite position before calling this. Works for
      // ANY ship (local, remote, bot), so there's no local special-
      // case. Falls back to screen centre if the entity has no live
      // sprite (despawned mid-warp / not spawned yet) so the effect
      // never vanishes.
      return args.entityGlobal ?? screenCentre;
    case 'world':
      // Game space (Y-up) → Pixi space (Y-down): negate Y, exactly as
      // every sprite is placed (`sprite.y = -ship.y`).
      return args.projectWorld(args.warpCenter.worldX, -args.warpCenter.worldY);
    case 'screen':
      return { x: args.warpCenter.screenX, y: args.warpCenter.screenY };
  }
}
