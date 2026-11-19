/**
 * `PixiRenderer` teardown: `dispose` and the sector-handoff effects reset —
 * lifted out of `PixiRenderer` (god-file split, slice 9). Bodies moved
 * verbatim; the renderer hands in `RendererTeardownRefs`, a getter view it
 * builds once (`initialized` and `effects` are written back through setters).
 * The DOM listener teardown sits next to its setup (`initDomListeners.ts`).
 */
import type { Application } from 'pixi.js';
import type { EffectsService } from '../../../effects/EffectsService';
import type { FxExplosions } from '../../art/fx/FxExplosions.js';
import type { FxFences, FxShields } from '../../art/fx/FxShields.js';
import type { ShipArtCtx } from '../../art/shipArtSprites.js';
import type { LoadCurtain } from '../LoadCurtain.js';
import { clearEngineShieldFxIds, type EngineShieldFxCtx } from '../engineShieldFxUpdater.js';
import type { HudDrainCtx } from '../hudDrainUpdater.js';
import type { RendererInputController } from '../rendererInputController.js';
import type { IncomingFireWarning } from '../../incoming/IncomingFireWarning.js';
import type { HelmCourseMarker } from '../../helm/HelmCourseMarker.js';
import type { HaloRadar } from '../../HaloRadar';
import type { LabelManager } from '../../Labels';
import type { SelectionBracket } from '../../SelectionBracket';
import type { HoverBracket } from '../../HoverBracket';
import type { FleetOverlay } from '../../FleetOverlay.js';
import type { MountVisualManager } from '../../MountVisualManager';
import type { BackgroundGrid } from '../../BackgroundGrid';
import type { StarfieldBackground } from '../../StarfieldBackground';
import { removeDomListeners } from './initDomListeners.js';

/** The renderer state teardown reads (live values: getters on the renderer). */
export interface RendererTeardownRefs {
  initialized: boolean;
  effects: EffectsService | null;
  readonly app: Application;
  readonly artCtx: ShipArtCtx;
  readonly curtain: LoadCurtain;
  readonly engineShieldFxCtx: EngineShieldFxCtx;
  readonly input: RendererInputController;
  readonly hudCtx: HudDrainCtx;
  readonly labels: LabelManager | null;
  readonly selectionBracket: SelectionBracket | null;
  readonly hoverBracket: HoverBracket | null;
  readonly mountVisuals: MountVisualManager;
  readonly halo: HaloRadar;
  readonly incomingFire: IncomingFireWarning;
  readonly helmMarker: HelmCourseMarker;
  readonly fleetOverlay: FleetOverlay | null;
  readonly backgroundGrid: BackgroundGrid | null;
  readonly starfield: StarfieldBackground | null;
  readonly fxExplosions: FxExplosions | null;
  readonly fxShields: FxShields | null;
  readonly fxFences: FxFences | null;
}

/**
 * Effects subsystem (plan `wiggly-puppy` M9). Wipe per-entity continuous
 * emitters + in-flight bursts + shield rings. Called from
 * `ColyseusClient.resetPredictionState()`'s sibling-line in the
 * `transit_ready` handler. The diff trackers are cleared too so the
 * destination sector's first frame re-registers emitters against the
 * fresh mirror state.
 */
export function resetEffectsForSectorHandoff(r: RendererTeardownRefs): void {
  r.effects?.resetForSectorHandoff();
  r.fxExplosions?.reset();
  r.incomingFire.reset();
  r.helmMarker.reset();
  r.fxShields?.reset();
  r.fxFences?.reset();
  clearEngineShieldFxIds(r.engineShieldFxCtx);
}

export function disposeRenderer(r: RendererTeardownRefs): void {
  r.artCtx.art?.destroy();
  r.artCtx.art = null;
  r.artCtx.handles.clear();
  if (!r.initialized) return;
  // Flip the flag FIRST so any rAF / ResizeObserver callback that fires
  // between here and the actual destroy() short-circuits cleanly. Without
  // this, the queued requestAnimationFrame(resize) at the end of init()
  // could land post-destroy and read a null renderer.
  r.initialized = false;
  // Tear down the warp filter chain (removes its ticker handler).
  r.curtain.destroy();
  // Wipe effects subsystem pools (particles, shock filters, etc.).
  if (r.effects) {
    r.effects.resetForSectorHandoff();
    r.effects = null;
  }
  // Clear the per-effect diff trackers so a re-init starts clean.
  clearEngineShieldFxIds(r.engineShieldFxCtx);
  removeDomListeners(r.app, r.input); // rendererSetup/initDomListeners.ts
  r.hudCtx.damageNumbers?.destroy();
  r.hudCtx.levelUpIcons?.destroy();
  r.hudCtx.healthBars?.destroy();
  r.labels?.destroy();
  r.selectionBracket?.destroy();
  r.hoverBracket?.destroy();
  r.mountVisuals.disposeAll();
  r.halo.destroy();
  r.incomingFire.destroy();
  r.helmMarker.destroy();
  r.fleetOverlay?.destroy();
  r.backgroundGrid?.destroy();
  r.starfield?.destroy();
  // Warp stage + filters live on app.stage so `app.destroy({ children: true })`
  // tears them down. warp.destroy() already removed the ticker handler.
  r.app.destroy(true, { children: true });
}
