/**
 * Main → Worker wire format. Discriminated union on `type`; every
 * variant is structured-cloneable (no functions, no DOM/Pixi handles,
 * no class instances). Locked by `protocol.test.ts`.
 */

import type { RenderMirror, WarpCenter } from '@core/contracts/IRenderer';
import type { EffectQuality } from '@core/contracts/IEffects';
import type { WarpParams } from './warpParams.js';
import type { SerialisedPointerEvent, SerialisedWheelEvent } from './serialisedEvents.js';
import type { SectorLiveState } from '../../../../shared-types/galaxySnapshot.js';
import type { SectorPresence } from '../../../../shared-types/galaxyPresence.js';

/**
 * Initialise the worker. Sent once after `new Worker(...)`.
 * `canvas` MUST be transferred (second arg to postMessage) — the
 * main thread loses control of it.
 */
export interface BootMsg {
  type: 'BOOT';
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  /**
   * Device pixel ratio at boot. `width`/`height` above are LOGICAL (CSS)
   * px; the worker passes `resolution: dpr` to Pixi (HiDPI contract:
   * backing buffer = width × resolution) with `autoDensity: false`
   * (the transferred OffscreenCanvas has no CSS box for Pixi to write).
   * DPR changes at runtime arrive via RESIZE.
   */
  dpr: number;
  /**
   * Optional `?zoom=` override (on-device crispness/framing A/B). Absent
   * → renderer uses its DEFAULT_GAMEPLAY_ZOOM. The worker has no `window`,
   * so the main thread reads the URL param and forwards it here.
   */
  zoom?: number;
  /**
   * Touch-device flag (Equinox P6.1). The worker has no reliable
   * `window.matchMedia`, so the main thread (which knows via `isTouchDevice()`)
   * forwards it; the worker's PixiRenderer seeds the placement ghost at
   * screen-centre on touch. Absent ⇒ desktop (ahead-of-ship + hover-follow).
   */
  isTouch?: boolean;
}

/**
 * Per-frame render request. Posted by the main thread after
 * `gameClient.updateMirror()`. The renderer reads this snapshot;
 * the worker's response (if any) is asynchronous via FEEDBACK.
 *
 * `RenderMirror` is plain data — no DOM/Pixi handles. Verified
 * structured-cloneable by `protocol.test.ts`.
 */
export interface MirrorUpdateMsg {
  type: 'MIRROR_UPDATE';
  mirror: RenderMirror;
}

/** GalaxyMapLayer overlay state — driven by Zustand useEffects in `App.tsx`. */
export interface SetVisibleMsg { type: 'SET_VISIBLE'; visible: boolean }
export interface SetCurrentSectorMsg { type: 'SET_CURRENT_SECTOR'; sectorKey: string | null }
export interface SetTransitDockedMsg { type: 'SET_TRANSIT_DOCKED'; docked: boolean }
/**
 * Switch the worker-hosted GalaxyMapLayer between the in-game additive
 * overlay (`overlay`) and the full-screen spawn/warp picker (`selector`).
 * The mode string is inlined (not imported from `galaxyLayerDecisions`)
 * to keep the worker-protocol dir free of client-render imports — same
 * convention every other message here follows.
 */
export interface SetOverlayModeMsg { type: 'SET_OVERLAY_MODE'; mode: 'overlay' | 'selector' }

/**
 * Live per-sector galaxy stats for the worker-hosted GalaxyMapLayer (Living
 * Galaxy P4b). `SectorLiveState` is a plain structured-cloneable shape from
 * shared-types (no Pixi/DOM/functions) — polled main-side by `useGalaxyStats`
 * off `GET /galaxy/snapshot` and pushed here for the live count glyphs.
 */
export interface SetGalaxyStatsMsg { type: 'SET_GALAXY_STATS'; stats: SectorLiveState[] }

/**
 * Equinox Phase 7 — the logged-in player's merged per-sector presence (own ships
 * + own structures) for the galaxy-map "my presence" overlay. Built on the main
 * thread (roster + GET /galaxy/presence) and pushed here.
 */
export interface SetPlayerPresenceMsg { type: 'SET_PLAYER_PRESENCE'; presence: SectorPresence[] }

/**
 * Canvas resize. Width/height in LOGICAL (CSS) px; `dpr` carries the
 * current devicePixelRatio so the worker re-applies it as the renderer
 * resolution (buffer = width × dpr). The worker resizes the renderer and
 * any layer overlays.
 */
export interface ResizeMsg {
  type: 'RESIZE';
  width: number;
  height: number;
  dpr: number;
}

/**
 * Pixi ticker FPS cap. See `PixiRenderer.setTickerMaxFPS`. `null` =
 * pause entirely; `undefined` = remove cap; number = throttle.
 */
export interface SetTickerFpsMsg {
  type: 'SET_TICKER_FPS';
  fps: number | null | undefined;
}

/**
 * Warp-mode render state toggle. See `IRenderer.setWarpMode`. The
 * worker forwards to its `PixiRenderer.setWarpMode(active)` which
 * applies the filter chain + animates streaks on the same Pixi stage
 * as gameplay — no second canvas.
 */
export interface SetWarpModeMsg {
  type: 'SET_WARP_MODE';
  active: boolean;
}

/** Sandbox-only: live-tune the active warp params. Production code never posts this. */
export interface SetWarpParamsMsg {
  type: 'SET_WARP_PARAMS';
  params: Partial<WarpParams>;
}

export interface SetWarpCenterMsg {
  type: 'SET_WARP_CENTER';
  center: WarpCenter | null;
}

/**
 * Sandbox-only: position the camera so a given world point sits at
 * screen centre. Used by the visual-effects sandbox to anchor world
 * (0, 0) at screen centre WITHOUT needing a local player ship to
 * follow. Production code uses Camera.follow on the local ship, not
 * this message.
 */
export interface SetCameraCenterMsg {
  type: 'SET_CAMERA_CENTER';
  worldX: number;
  worldY: number;
}

/**
 * Fire the "warp-in" companion effect — a flash + single big ripple at
 * the supplied centre, no preceding spool/climax. Used when a ship
 * arrives at a sector (the receiving end of a warp). `setWarpMode(false)`
 * fires the same flash+ripple at the moment of departure (the exit
 * burst). Production: per-ship-per-event, fired by the join/transit
 * flow with the ship's spawn world position.
 */
export interface TriggerWarpInMsg {
  type: 'TRIGGER_WARP_IN';
  center: WarpCenter | null;
}

/**
 * Show or hide the load curtain — an opaque overlay that hides the
 * canvas during the join + transit load periods. Driven by App.tsx
 * orchestration: visible while connecting, while waiting for the
 * first snapshot + readiness gates, and during the IN_TRANSIT /
 * ARRIVED travel window of inter-sector transit. The renderer alpha-
 * tweens between target states (200 ms rise, 380 ms fade — see
 * `CURTAIN_*_MS` in `PixiRenderer.ts`).
 */
export interface SetLoadCurtainMsg {
  type: 'SET_LOAD_CURTAIN';
  active: boolean;
}

/**
 * Native pointer event, forwarded from the main thread because
 * `OffscreenCanvas` has no DOM event source in the worker (per
 * pixijs/pixijs#9132). The worker hand-rolled camera consumes these
 * via a state machine (`Camera.onPointerDown/Move/Up`).
 */
export interface PointerEventMsg {
  type: 'POINTER_EVENT';
  native: SerialisedPointerEvent;
}
export interface WheelEventMsg {
  type: 'WHEEL_EVENT';
  native: SerialisedWheelEvent;
}

/**
 * Toggle the worker's per-frame diagnostic-marker emission (F1 of the
 * warp-spool perf investigation — see
 * `docs/HANDOFF-warp-spool-perf-followup.md`). When `enabled` the worker
 * `postMessage`s a `FRAME_MARKERS` message at the tail of each
 * `MIRROR_UPDATE`; when disabled it posts NOTHING (zero extra IPC in
 * production). The cheap `performance.now()` brackets that produce the
 * numbers stay unconditional in the worker (sub-µs, uniform), so the
 * markers-off baseline is the production cost.
 *
 * Sent once at `WorkerRendererClient.init` based on `isDiagEnabled()`
 * (`?diag=1` in the URL OR `navigator.webdriver`), so E2E specs /
 * diagnostic captures get markers with zero cost on normal sessions.
 */
export interface SetDiagMarkersMsg {
  type: 'SET_DIAG_MARKERS';
  enabled: boolean;
}

/**
 * Trigger a one-shot effect at a world point. Visual-effects subsystem
 * (plan `wiggly-puppy` M2). Production code rarely posts this directly —
 * most triggers ride `RenderMirror.pendingEffectTriggers` (drained by
 * the renderer each frame). Direct post is used by the sandbox + by
 * `IFilterEffects.triggerOneShotFilter` to attach a one-shot
 * ShockwaveFilter / flash overlay.
 */
export interface TriggerEffectMsg {
  type: 'TRIGGER_EFFECT';
  effect:
    | 'impact'
    | 'destruction'
    | 'shield-hit'
    | 'warp-arrive'
    | 'destruction-shock'
    | 'shield-flash';
  worldX: number;
  worldY: number;
  /** 0..1 multiplier on default count + lifetime. Defaults to 1. */
  intensity?: number;
  /** Optional tint override. RGB hex like 0xff66aa. */
  tint?: number;
  /** Optional entity id (currently unused; reserved for entity-glued
   *  one-shots like the destruction position lookup). */
  entityId?: string;
}

/**
 * External quality push. Posted by the main-thread `PerfMonitor` ONLY on
 * tier transition (≤ once per 500 ms by hysteresis construction), NEVER
 * per-frame. The worker's `EffectsBudget` keeps the more-restrictive of
 * (locally-resolved tier, pushed tier).
 */
export interface SetEffectQualityMsg {
  type: 'SET_EFFECT_QUALITY';
  level: EffectQuality;
}

/**
 * Sandbox-only: live-tune a single effect's params. Production code never
 * posts this; per-effect defaults live in
 * `src/client/effects/config/effectDefaults.ts`. Mirrors the
 * `SET_WARP_PARAMS` pattern.
 */
export interface SetEffectParamsMsg {
  type: 'SET_EFFECT_PARAMS';
  effect: 'engine' | 'laser' | 'shield' | 'impact' | 'destruction';
  params: Record<string, number | boolean>;
}

/**
 * Sector-handoff reset for the effects subsystem (M9). Posted from the
 * main thread when `transit_ready` fires; the worker calls
 * `pixiRenderer.resetEffectsForSectorHandoff()` which delegates to
 * `EffectsService.resetForSectorHandoff()`.
 */
export interface ResetEffectsHandoffMsg {
  type: 'RESET_EFFECTS_HANDOFF';
}

/** Tear-down request. Worker should clean its Pixi handles then `self.close()`. */
export interface DisposeMsg { type: 'DISPOSE' }

export type MainToWorkerMsg =
  | BootMsg
  | MirrorUpdateMsg
  | SetVisibleMsg
  | SetCurrentSectorMsg
  | SetTransitDockedMsg
  | SetOverlayModeMsg
  | SetGalaxyStatsMsg
  | SetPlayerPresenceMsg
  | ResizeMsg
  | SetTickerFpsMsg
  | SetWarpModeMsg
  | SetWarpParamsMsg
  | SetWarpCenterMsg
  | SetCameraCenterMsg
  | TriggerWarpInMsg
  | SetLoadCurtainMsg
  | SetDiagMarkersMsg
  | TriggerEffectMsg
  | SetEffectQualityMsg
  | SetEffectParamsMsg
  | ResetEffectsHandoffMsg
  | PointerEventMsg
  | WheelEventMsg
  | DisposeMsg;
