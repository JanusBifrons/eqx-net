/**
 * The frame passes of `PixiRenderer.update()`, in order — lifted out of
 * `PixiRenderer` (god-file split) so the phone lane can time each one
 * (`debug/perf/lanePhaseTiming.ts`; `updateEntitySprites` marks its own
 * sub-passes). Off the lane each mark is one null check; nothing allocates (#14).
 */

import type { RenderMirror } from '@core/contracts/IRenderer';
import { updateEntitySprites, updateProjectilesAndGhost } from './worldSpriteUpdater.js';
import { updateBeamsAndCamera, updateBackdrop, updateHudOverlays } from './frameViewUpdater.js';
import { writeFrameFeedback, tickFrameEffects } from './frameFeedbackUpdater.js';
import { LanePhase, lanePhaseMark, lanePhaseStart } from '../../debug/perf/lanePhaseTiming.js';
import type { RendererFrameCtx } from './frameCtx.js';

/** Run the frame passes over the pooled frame ctx (`frameCtx.ts`). */
export function runFramePasses(mirror: RenderMirror, f: RendererFrameCtx): void {
  updateEntitySprites(mirror, f); // pixi/worldSpriteUpdater.ts
  let t = lanePhaseStart();
  updateProjectilesAndGhost(mirror, f);
  t = lanePhaseMark(LanePhase.projectiles, t);
  updateBeamsAndCamera(mirror, f); // pixi/frameViewUpdater.ts
  t = lanePhaseMark(LanePhase.beamsCamera, t);
  updateBackdrop(mirror, f); // after the camera moved: stars and grid don't lag a frame
  t = lanePhaseMark(LanePhase.backdrop, t);
  updateHudOverlays(mirror, f);
  t = lanePhaseMark(LanePhase.hudOverlays, t);
  writeFrameFeedback(mirror, f); // pixi/frameFeedbackUpdater.ts
  t = lanePhaseMark(LanePhase.feedback, t);
  tickFrameEffects(mirror, f); // after every sprite pass (one pose per frame)
  lanePhaseMark(LanePhase.effects, t);
}
