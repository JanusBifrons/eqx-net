/**
 * Per-frame HUD drains — damage numbers, level-up icons and health bars —
 * lifted out of `PixiRenderer.update()` (god-file split, Phase 4).
 *
 * `spawnDamageNumbers(mirror, ctx)` drains `mirror.pendingDamageNumbers`
 * into floating text (before the hit events, as before); `updateHudDrains`
 * then drains the damage-number cancels, ticks the numbers, pops level-up
 * icons and feeds the health bars. The ctx is built once by
 * `createHudDrainCtx` (renderer construction, since `rekey` / `dispose` may
 * read it); `init` fills the managers and the kill switches.
 * Allocation-free per frame (invariant #14).
 */

import type { RenderMirror } from '@core/contracts/IRenderer';
import type { DamageNumberManager } from '../DamageNumbers';
import type { LevelUpIconManager } from '../LevelUpIcons';
import type { HealthBarManager } from '../HealthBars';

export interface HudDrainCtx {
  /** Set in `init`. */
  damageNumbers: DamageNumberManager | null;
  /** Phase 4 WS-B1 — pooled screenspace level-up icon (own ship). */
  levelUpIcons: LevelUpIconManager | null;
  healthBars: HealthBarManager | null;
  /** Phone-stall thermal-isolation switches, read once at init
   *  (`readFxKillSwitches`). */
  dmgNumbersDisabled: boolean;
  selfDmgNumbersDisabled: boolean;
  healthBarsDisabled: boolean;
}

/** Build the HUD-drain ctx once (renderer construction). */
export function createHudDrainCtx(): HudDrainCtx {
  return {
    damageNumbers: null, levelUpIcons: null, healthBars: null,
    dmgNumbersDisabled: false, selfDmgNumbersDisabled: false, healthBarsDisabled: false,
  };
}

export function spawnDamageNumbers(mirror: RenderMirror, ctx: HudDrainCtx): void {
  // Drain pending damage numbers and spawn floating text. update()
  // must be OUTSIDE the spawn-drain block — sub-managers need to
  // tick every frame to advance lifetime + counter-scale.
  if (!ctx.dmgNumbersDisabled && ctx.damageNumbers && mirror.pendingDamageNumbers) {
    for (const dn of mirror.pendingDamageNumbers) {
      if (ctx.selfDmgNumbersDisabled && dn.targetId === mirror.localPlayerId) continue;
      ctx.damageNumbers.spawn(dn.targetId, dn.x, dn.y, dn.damage, dn.tag);
    }
    mirror.pendingDamageNumbers.length = 0;
    // A ship that exploded this frame closes its number AFTER the drain,
    // so the killing blow still lands in it but nothing later does (late
    // hits climbed it over the wreck: fight-clip review 2026-11-13). The
    // set is a one-frame trigger, empty on almost every frame.
    if (mirror.explodingShips && mirror.explodingShips.size > 0) {
      for (const id of mirror.explodingShips) ctx.damageNumbers.markDead(id);
    }
  } else if (ctx.dmgNumbersDisabled && mirror.pendingDamageNumbers) {
    // Drain even when disabled — don't let the queue grow unbounded.
    mirror.pendingDamageNumbers.length = 0;
  }
}

export function updateHudDrains(mirror: RenderMirror, ctx: HudDrainCtx): void {
  // weapon-hit-prediction Phase 2 — hard-cancel mispredicted / TTL-expired
  // predicted numbers by tag. Drained AFTER the spawn pass (a predict +
  // rollback in the same frame nets to nothing) and BEFORE update() (a
  // cancelled number gets zero frames of life).
  if (ctx.damageNumbers && mirror.pendingDamageNumberCancels) {
    for (const tag of mirror.pendingDamageNumberCancels) {
      ctx.damageNumbers.cancelByTag(tag);
    }
    mirror.pendingDamageNumberCancels.length = 0;
  }
  if (!ctx.dmgNumbersDisabled) ctx.damageNumbers?.update(mirror.timeScale ?? 1); // game-time lifetime

  // Phase 4 WS-B1 — drain the level-up icon queue and pop a pooled
  // screenspace icon over the named ship's CURRENT pose. The queue's
  // length-reset is owned by `consumeOneFrameTriggers` on render frames only
  // (same skip-frame discipline as explodingShips / pendingEffectTriggers).
  // DO NOT add `.length = 0` here.
  if (ctx.levelUpIcons && mirror.pendingLevelUps) {
    for (const ev of mirror.pendingLevelUps) {
      const ship = mirror.ships.get(ev.playerId);
      if (!ship) continue;
      ctx.levelUpIcons.spawn(ship.x, ship.y, ev.newLevel);
    }
  }
  ctx.levelUpIcons?.update();

  if (!ctx.healthBarsDisabled && ctx.healthBars && mirror.pendingHealthBarHits) {
    for (const hb of mirror.pendingHealthBarHits) {
      ctx.healthBars.onHit(hb.entityId, hb.healthPct, hb.shieldPct, hb.preHealthPct);
    }
    mirror.pendingHealthBarHits.length = 0;
  } else if (ctx.healthBarsDisabled && mirror.pendingHealthBarHits) {
    mirror.pendingHealthBarHits.length = 0;
  }
  if (!ctx.healthBarsDisabled) ctx.healthBars?.update(mirror);
}
