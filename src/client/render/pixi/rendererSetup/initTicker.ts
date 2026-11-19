/**
 * `init` step: the renderer's Pixi ticker callback (camera momentum + follow,
 * the fleet overlay, art packing / lighting / collection) — lifted out of
 * `PixiRenderer` (god-file split, slice 7). The callback is bound once; each
 * tick reads the pooled frame ctx (`../frameCtx.ts`) and allocates nothing.
 */

import type { Container } from 'pixi.js';
import { litPass } from '../../art/litPass.js';
import { MachinedShipSprite } from '../../art/MachinedShipSprite.js';
import { MachinedFlatSprite } from '../../art/MachinedFlatSprite.js';
import type { RendererFrameCtx } from '../frameCtx.js';

/** How often (frames) unused older-sector art is freed (~2 s at 60 fps). */
const ART_COLLECT_EVERY_FRAMES = 120;

/** Record the Machined art a sprite draws (for art collection). */
function noteShownArt(sprite: Container, out: Set<object>): void {
  if (sprite instanceof MachinedShipSprite || sprite instanceof MachinedFlatSprite) out.add(sprite.art);
}

/** Free the atlas pages of an older sector's art once no sprite or gun
 *  draws it (after a sector trip), so a phone's few pages don't fill. */
function collectUnusedArt(ctx: RendererFrameCtx): void {
  const r = ctx.r;
  const art = r.artCtx.art;
  if (!art) return;
  const inUse = ctx.artInUse;
  inUse.clear();
  for (const h of r.artCtx.handles.values()) inUse.add(h);
  r.mountVisuals.addArtHandlesTo(inUse);
  const shown = ctx.artShown;
  shown.clear();
  for (const sp of r.sprites.values()) noteShownArt(sp, shown);
  art.collect(inUse, shown);
  inUse.clear();
  shown.clear();
}

/** Drive Camera momentum + follow each frame (works in both contexts). */
export function installFrameTicker(ctx: RendererFrameCtx): void {
  const r = ctx.r;
  r.app.ticker.add(() => {
    // deltaMS keeps the Camera's zoom-ease framerate-independent
    // (60 / 90 / 120 Hz devices ease at the same wall-clock rate).
    r.camera.tick(r.app.ticker.deltaMS);
    // Screen-space overlays project through THIS frame's camera (after its
    // tick), the transform the world renders with below.
    r.input.drawFleetOverlay();
    if (r.ringProbeOn) r.captureFleetRingProbe();
    // Machined art: pack finished bakes every frame — including on the
    // galaxy map / warp screen, where `update()` doesn't run, so the
    // warm-up lands before the player joins.
    r.artCtx.art?.tick();
    // GPU-lit art: light every lit mesh from this frame's lights, before render.
    if (litPass.settings && r.artCtx.art && litPass.count > 0) litPass.finish(r.world, r.artCtx.art.lightRig, r.app.renderer.resolution);
    if (r.artCtx.art && ++ctx.artCollectFrame >= ART_COLLECT_EVERY_FRAMES) {
      ctx.artCollectFrame = 0;
      collectUnusedArt(ctx);
    }
    if (r.artStatsHook) (globalThis as { __eqxArtStats?: () => unknown }).__eqxArtStats = r.artStatsHook;
  });
}
