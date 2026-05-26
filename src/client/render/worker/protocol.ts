/**
 * Wire protocol for the OffscreenCanvas renderer worker.
 *
 * Both directions are discriminated unions on `type` so the
 * message-handler switches are exhaustiveness-checked at compile time.
 * Plain TS types only — no class instances, no functions, no DOM
 * handles, no Pixi handles. Every variant must be structured-cloneable
 * so the postMessage hop costs nothing extra.
 *
 * See plan `~/.claude/plans/humble-strolling-coral.md` Phase 3 for
 * the migration context. The pattern follows
 * `src/core/physics/worker.ts` for the message-shape style (Node
 * worker_threads worker, not directly reusable in the browser).
 *
 * This file is a barrel — concrete types live under `protocol/`:
 *   - `protocol/serialisedEvents.ts` (SerialisedPointerEvent + SerialisedWheelEvent)
 *   - `protocol/warpParams.ts`       (WarpParams + DEFAULT_WARP_PARAMS)
 *   - `protocol/mainToWorker.ts`     (all main→worker messages + MainToWorkerMsg union)
 *   - `protocol/workerToMain.ts`     (all worker→main messages + FrameMarkers + WorkerToMainMsg union)
 *
 * Locked by `protocol.test.ts` (structuredClone roundtrip per variant).
 */

import type { WarpCenter } from '@core/contracts/IRenderer';

// Re-export so existing client-side imports from this module keep working.
export type { WarpCenter };

export type {
  SerialisedPointerEvent,
  SerialisedWheelEvent,
} from './protocol/serialisedEvents.js';

export type { WarpParams } from './protocol/warpParams.js';
export { DEFAULT_WARP_PARAMS } from './protocol/warpParams.js';

export type {
  BootMsg,
  MirrorUpdateMsg,
  SetVisibleMsg,
  SetCurrentSectorMsg,
  SetTransitDockedMsg,
  ResizeMsg,
  SetTickerFpsMsg,
  SetWarpModeMsg,
  SetWarpParamsMsg,
  SetWarpCenterMsg,
  SetCameraCenterMsg,
  TriggerWarpInMsg,
  SetLoadCurtainMsg,
  PointerEventMsg,
  WheelEventMsg,
  SetDiagMarkersMsg,
  DisposeMsg,
  MainToWorkerMsg,
} from './protocol/mainToWorker.js';

export type {
  ReadyMsg,
  FeedbackMsg,
  OverlayTappedMsg,
  WorkerErrorMsg,
  FrameMarkers,
  FrameMarkersMsg,
  WorkerToMainMsg,
} from './protocol/workerToMain.js';
