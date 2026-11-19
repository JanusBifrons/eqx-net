import type { PerfProbeOp, RenderPerfReading } from './rendererPerfProbe.js';
import type { RenderMirror } from './render/RenderMirror.js';
import type { RendererFeedback } from './render/RendererFeedback.js';
import type { IFleetView } from './render/IFleetView.js';
import type { IRadarView } from './render/IRadarView.js';
import type { ICameraControl } from './render/ICameraControl.js';
export type { PerfProbeOp, PerfFrameSummary, RenderPerfReading, RenderCountReading } from './rendererPerfProbe.js';
export * from './render/ShipRenderState.js';
export * from './render/SwarmRenderState.js';
export * from './render/StructureRenderState.js';
export * from './render/ProjectileRenderState.js';
export type * from './render/RenderMirror.js';
export type * from './render/RendererFeedback.js';
export type * from './render/IFleetView.js';
export type * from './render/IRadarView.js';
export type * from './render/ICameraControl.js';

/** The renderer contract. Data types live in `render/*RenderState.ts`; methods
 *  are grouped into `IFleetView`, `IRadarView` and `ICameraControl`. */
export interface IRenderer extends IFleetView, IRadarView, ICameraControl {
  /** Perf scenes: enable / reset / read the renderer's frame-cost probe. Optional; null when not enabled. */
  perfProbe?(op: PerfProbeOp): Promise<RenderPerfReading | null>;
  // Container is typed as unknown here so core stays DOM-free.
  // Client implementations narrow it to HTMLElement.
  init(container: unknown): Promise<void>;
  update(mirror: RenderMirror): void;
  /**
   * Attach a screen-space overlay layer to the renderer's stage, above the
   * world viewport. Used by the in-game galaxy-map overlay (Map B) — a
   * Pixi `Container` of hex graphics that the consumer constructs and hands
   * to the renderer at bootstrap. The renderer simply parents the container;
   * it never imports galaxy code, preserving the DI seam.
   *
   * `overlay` is typed as `unknown` so this contract stays Pixi-free; the
   * concrete `PixiRenderer` narrows it to `Container`.
   */
  addOverlayContainer(overlay: unknown): void;
  /**
   * Read the most recent feedback the renderer wrote at the end of its
   * last `update()` call. See `RendererFeedback`.
   *
   * Today: backed by an in-renderer field (sync update). Future
   * (worker migration): backed by a main-thread cache populated by
   * FEEDBACK postMessage from the renderer worker.
   */
  getFeedback(): RendererFeedback;
  /**
   * Pixi ticker FPS cap.
   *  - `undefined` ⇒ uncapped (production default).
   *  - finite number ⇒ throttle to that FPS.
   *  - `null` ⇒ pause the ticker entirely. Used by `App.tsx` under
   *    Playwright (`navigator.webdriver`) when a UI overlay covers the
   *    game surface, so the renderer stops competing with the CDP loop
   *    for the main thread.
   */
  setTickerMaxFPS(fps: number | null | undefined): void;
  /**
   * Show or hide the load curtain — an opaque overlay above the world
   * but below the React HUD. Hides the canvas during the join +
   * transit load periods so the player doesn't see ship-at-(0,0)
   * ghost frames or partial mirror state. The renderer alpha-tweens
   * between target states internally; callers just flip the bool.
   */
  setLoadCurtain(active: boolean): void;
  /**
   * The sector being shown changed (null on the galaxy map). Picks the new
   * backdrop's nebula (plan iridescent-seeking-rainbow v3, B2). On the worker
   * path the worker already hears it through `SET_CURRENT_SECTOR`.
   */
  setSector(sectorKey: string | null): void;
  /**
   * Effects subsystem (plan `wiggly-puppy` M9): drop per-entity
   * continuous emitters + in-flight bursts on sector handoff. Called
   * from `ColyseusClient.resetPredictionState()`'s sibling-line in the
   * `transit_ready` handler — same discipline as `rearmJoinReadiness`.
   * Optional behaviour: no-op if the renderer has no `EffectsService`
   * (e.g. when `?effects=0` is set or when running headless tests).
   */
  resetEffectsForSectorHandoff(): void;
  dispose(): void;
}
