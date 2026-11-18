/**
 * Per-frame hit events (impact sparks, wall hits, shield contacts, one-shot
 * filters) and the new-shields frame gate — lifted out of
 * `PixiRenderer.update()` (god-file split, Phase 4).
 *
 * `beginShieldFrame(ctx)` opens the new shields' frame and records the gate
 * (`fxShieldsOn`) that beams, hit FX and the shield aura share this frame.
 * `updateHitEvents(mirror, ctx)` drains `mirror.pendingEffectTriggers` into
 * the effects service, fences and shields. The ctx is built once by
 * `createHitEventCtx` (renderer construction); `init` fills `fxShields` /
 * `fxFences`, and the caller writes `effects` before each call.
 * Allocation-free per frame (invariant #14) beyond the debt noted inline.
 */

import type { RenderMirror } from '@core/contracts/IRenderer';
import type { EffectsService } from '../../effects/EffectsService';
import type { FxFences, FxShields, ShieldPoseFn } from '../art/fx/FxShields.js';

export interface HitEventCtx {
  /** Written by the caller each frame (nulled on dispose). */
  effects: EffectsService | null;
  /** New shields are on this frame (written by `beginShieldFrame`). */
  fxShieldsOn: boolean;
  /** Set in `init` when the new effects are on. */
  fxShields: FxShields | null;
  fxFences: FxFences | null;
  fxShieldPose: ShieldPoseFn;
  fxNow: () => number;
}

export interface HitEventCtxRefs {
  fxShieldPose: ShieldPoseFn;
  fxNow: () => number;
}

/** Build the hit-event ctx once (renderer construction). */
export function createHitEventCtx(refs: HitEventCtxRefs): HitEventCtx {
  return { effects: null, fxShieldsOn: false, fxShields: null, fxFences: null, fxShieldPose: refs.fxShieldPose, fxNow: refs.fxNow };
}

/** New shields (B5): open the frame; beams and hits feed it, the shield sync
 *  closes it. Returns the gate shared with beams + hit FX. */
export function beginShieldFrame(ctx: HitEventCtx): boolean {
  ctx.fxShieldsOn = ctx.fxShields !== null && ctx.fxShields.ready();
  if (ctx.fxShieldsOn) ctx.fxShields!.begin();
  return ctx.fxShieldsOn;
}

export function updateHitEvents(mirror: RenderMirror, ctx: HitEventCtx): void {
  // Effects subsystem (M7 — plan wiggly-puppy): drain the effect-
  // trigger queue and dispatch to spawnBurst / triggerOneShotFilter.
  // The queue's length-reset is owned by `perFrameTriggers.consumeOne-
  // FrameTriggers` on render frames only (worker every-other-RAF
  // skip-frames must NOT silently drain — same discipline as
  // explodingShips). DO NOT add `.length = 0` here.
  if (ctx.effects && mirror.pendingEffectTriggers) {
    for (const ev of mirror.pendingEffectTriggers) {
      if (ev.kind === 'wall-hit') {
        // A fence stopped a shot: a ripple on the wall (new look), else
        // shield-tinted sparks (today's look).
        if (!ctx.fxFences?.hitAt(ev.worldX, ev.worldY, ctx.fxNow())) {
          ctx.effects.spawnBurst('impact', ev.worldX, ev.worldY, { tint: 0x88ddff });
        }
      } else if (ev.kind === 'shield-contact') {
        // A collision touched a shield: the same flash as a shot's hit,
        // facing the other body (drawn only if the shield is up).
        if (ev.entityId) {
          ctx.effects.pulseShield(ev.entityId);
          if (ctx.fxShieldsOn) ctx.fxShields!.hitAt(ev.entityId, ev.worldX, ev.worldY, ctx.fxNow(), ctx.fxShieldPose);
        }
      } else if (ev.kind === 'destruction-shock' || ev.kind === 'shield-flash') {
        ctx.effects.triggerOneShotFilter(ev.kind, ev.worldX, ev.worldY);
      } else {
        ctx.effects.spawnBurst(ev.kind, ev.worldX, ev.worldY, {
          ...(ev.intensity !== undefined ? { intensity: ev.intensity } : {}),
          ...(ev.tint !== undefined ? { tint: ev.tint } : {}),
        });
        // Shield-hit impacts also pulse the target's shield ring.
        if (ev.kind === 'impact' && ev.tint === 0x88ddff && ev.entityId) {
          ctx.effects.pulseShield(ev.entityId);
          if (ctx.fxShieldsOn) ctx.fxShields!.hitAt(ev.entityId, ev.worldX, ev.worldY, ctx.fxNow(), ctx.fxShieldPose);
        }
      }
    }
  }
}
