/**
 * Client-side combat-feedback sink. The renderer / audio side
 * implements this; the net side (CombatFeedbackBridge) calls it on
 * receipt of `damage` / `destroy` / `hit_ack` / warp-phase events.
 *
 * NAMED `ICombatFeedbackSink` (not `IRendererFeedback`) to avoid
 * collision with the existing `IRenderer.getFeedback()` method, which
 * is the OUTBOUND main↔worker per-frame return path. This contract is
 * the INBOUND server-event → renderer side-effect path. Two surfaces,
 * two names.
 *
 * Today (pre-refactor) the renderer side wires these handlers
 * inline in `PixiRenderer` / `WorkerRendererClient`. Commit 14 of the
 * god-file refactor extracts the implementation as `CombatFeedbackBus.ts`;
 * commit 18 extracts the caller side as `CombatFeedbackBridge.ts`.
 *
 * Single hit_ack/DamageEvent reconcile path (merge `fa6f8da`) is
 * preserved: `onDamage` is the only entry point for the on-screen
 * damage VFX path; `CombatFeedbackBridge.singlePath.test.ts` asserts
 * this in commit 18.
 */

export interface DamageVfxEvent {
  readonly targetId: string;
  readonly x: number;
  readonly y: number;
  readonly damage: number;
  readonly shieldBroken: boolean;
  /** Server tick at which damage applied (for tag/ordering). */
  readonly tick: number;
}

export interface DestroyVfxEvent {
  readonly entityId: string;
  readonly x: number;
  readonly y: number;
  /** Kind of explosion to play (drone vs ship vs asteroid). */
  readonly kind: 'ship' | 'drone' | 'asteroid' | 'wreck';
}

export type WarpPhase =
  | 'spool_start'
  | 'spool_progress'
  | 'depart'
  | 'arrive'
  | 'arrive_burst'
  | 'curtain_lift';

export interface WarpPhaseEvent {
  readonly phase: WarpPhase;
  /** 0-1 progress for spool_progress, otherwise undefined. */
  readonly progress?: number;
}

export interface ICombatFeedbackSink {
  onDamage(e: DamageVfxEvent): void;
  onDestroy(e: DestroyVfxEvent): void;
  onWarpPhase(e: WarpPhaseEvent): void;
}
