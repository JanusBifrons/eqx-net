/**
 * weapon-hit-prediction Phase 2 — client predicted-resolution.
 *
 * Extracted from ColyseusClient so the fire-time hit decision is unit-
 * testable (fake predWorld + fake feedback sink + the real pure
 * `HitPredictionLedger`). The renderer/Colyseus side-effects stay in the
 * big file; only the branching lives here (client CLAUDE.md Phase-A3).
 *
 * Favor-the-shooter pose alignment: the ray is cast against the SAME
 * predWorld the player sees (`predWorld.hitscan`, the exact call
 * `updateLiveBeam` already makes). NO client-side lag-comp ring — that
 * would be a second drone-pose authority fighting the single-path
 * interpolation the drone pivot established (root CLAUDE.md #12). The
 * prediction is a *read* of the existing single-path pose.
 *
 * Mode handling reads `weaponDef.mode`/`.damage` (passed by the caller);
 * no weapon-id branch. Projectile note: the predicted *target* is resolved
 * with the same hitscan ray as a straight-flight proxy (World exposes no
 * swept-body enumeration, and decision #2 leaves the bolt untouched +
 * reconciled by the eventual DamageEvent/TTL anyway — so an approximate
 * predicted target that the authoritative path corrects is correct by
 * construction). `mode` is still threaded to the ledger so reconcile
 * routes correctly (projectile ignores the ack; hitscan uses it).
 */
import type { HitPredictionLedger, AckResult } from '@core/combat/HitPrediction';
import type { WeaponMode } from '@core/combat/WeaponCatalogue';

/** The single predWorld method the prediction needs — same signature as
 *  `World.hitscan` (excludes the shooter, returns the first entity hit). */
export interface PredHitscanWorld {
  hitscan(
    fromX: number,
    fromY: number,
    dirX: number,
    dirY: number,
    maxDist: number,
    excludeId: string,
  ): { hitId: string; dist: number } | null;
}

/** Per-mount fire ray, already barrel-offset — identical geometry to the
 *  ghost-spawn / `updateLiveBeam` loop in ColyseusClient. */
export interface MountFireGeom {
  fromX: number;
  fromY: number;
  fwdX: number;
  fwdY: number;
}

export interface ClosestHit {
  hitId: string;
  dist: number;
  hitX: number;
  hitY: number;
}

/** Immediate presentation surface for a predicted hit. The ColyseusClient
 *  adapter routes these onto the existing `mirror.pendingDamageNumbers`
 *  drain (tagged with `clientShotId` so a mispredict/TTL can hard-cancel
 *  it) and the `_damageFlashFrames` map (the same 6-frame flash the
 *  authoritative `handleDamage` uses). v1 scope = number + flash only
 *  (decision #3: NO predicted healthbar/kills — those need authoritative
 *  health and stay driven by the real DamageEvent). */
export interface PredictedFeedbackSink {
  pushDamageNumber(x: number, y: number, damage: number, tag: string): void;
  flashTarget(targetId: string): void;
}

/**
 * Aggregate the CLOSEST hit across every mount in the salvo. The server's
 * `hit_ack` reports the closest mount-hit of the fire (SectorRoom
 * bestHit*), so the client prediction mirrors that exactly — one aggregate
 * outcome per fire, not one per barrel. Ties resolve to the first mount in
 * iteration order (deterministic; matches the server's `<` comparison).
 */
export function resolveClosestPredictedHit(
  world: PredHitscanWorld,
  mounts: ReadonlyArray<MountFireGeom>,
  maxDist: number,
  excludeId: string,
): ClosestHit | null {
  let best: ClosestHit | null = null;
  for (const m of mounts) {
    const h = world.hitscan(m.fromX, m.fromY, m.fwdX, m.fwdY, maxDist, excludeId);
    if (h && (best === null || h.dist < best.dist)) {
      best = {
        hitId: h.hitId,
        dist: h.dist,
        hitX: m.fromX + m.fwdX * h.dist,
        hitY: m.fromY + m.fwdY * h.dist,
      };
    }
  }
  return best;
}

export interface PredictShotParams {
  ledger: HitPredictionLedger;
  sink: PredictedFeedbackSink;
  world: PredHitscanWorld;
  clientShotId: string;
  /** `getWeapon(weaponId).mode` — routes ledger reconcile, not geometry. */
  mode: WeaponMode;
  /** `getWeapon(weaponId).damage` — the optimistic number shown. */
  damage: number;
  mounts: ReadonlyArray<MountFireGeom>;
  maxDist: number;
  excludeId: string;
  nowMs: number;
}

/**
 * Predict a shot's outcome at fire time and emit immediate feedback.
 * Records the prediction in the ledger (ALWAYS — even a predicted miss, so
 * the ack can resolve it as noop/false_negative in Phase 3) and, only when
 * a target was hit, pushes a tagged damage number + sets the hit flash.
 * Returns the predicted target id (`null` = predicted miss) for the
 * caller's fire diagnostics. Pure wrt I/O — all effects go through
 * `sink`/`ledger`.
 */
export function predictShotOutcome(p: PredictShotParams): string | null {
  const hit = resolveClosestPredictedHit(p.world, p.mounts, p.maxDist, p.excludeId);
  const targetId = hit ? hit.hitId : null;
  p.ledger.predict(p.clientShotId, p.mode, targetId, p.damage, p.nowMs);
  if (hit) {
    p.sink.pushDamageNumber(hit.hitX, hit.hitY, p.damage, p.clientShotId);
    p.sink.flashTarget(hit.hitId);
  }
  return targetId;
}

/** Presentation-correction surface for the reconcile path (Phase 3). The
 *  ColyseusClient adapter routes these onto the existing mirror drains:
 *  cancel → `mirror.pendingDamageNumberCancels`; flash-clear →
 *  `_damageFlashFrames.delete`. */
export interface ReconcileFeedbackSink {
  cancelPredictedNumber(clientShotId: string): void;
  clearPredictedFlash(targetId: string): void;
}

/**
 * THE SINGLE reconcile path for a hitscan `hit_ack`. Applies it to the
 * ledger and emits the resulting presentation correction:
 *  - `confirmed`  → keep the predicted number (ledger is now `settled`, so
 *                   the imminent authoritative DamageEvent de-dupes it);
 *                   nothing emitted here.
 *  - `rolled_back`→ the shot missed/was rejected server-side: hard-cancel
 *                   the predicted number + clear its flash THIS frame.
 *  - `corrected`  → server hit a different target: hard-cancel the
 *                   mispredicted number + clear the WRONG target's flash;
 *                   the authoritative DamageEvent shows the real hit.
 *  - `false_negative`/`noop` → nothing (the authoritative path is
 *                   untouched — no predicted number existed to undo).
 * Returns the ledger result for the caller's diagnostics. Projectile
 * predictions return `noop` here (their sole authority is the eventual
 * DamageEvent / TTL — never the ack).
 */
export function reconcileAckToFeedback(
  ledger: HitPredictionLedger,
  clientShotId: string,
  ack: { hit: boolean; targetId?: string; damage?: number },
  sink: ReconcileFeedbackSink,
  nowMs: number,
): AckResult {
  const r = ledger.reconcileAck(clientShotId, ack, nowMs);
  if (r.kind === 'rolled_back') {
    sink.cancelPredictedNumber(r.clientShotId);
    sink.clearPredictedFlash(r.targetId);
  } else if (r.kind === 'corrected') {
    sink.cancelPredictedNumber(r.clientShotId);
    if (r.fromTargetId) sink.clearPredictedFlash(r.fromTargetId);
  }
  return r;
}

/**
 * THE SINGLE reconcile path for an authoritative `DamageEvent`. Returns
 * whether the caller (`handleDamage`) must SUPPRESS its duplicate damage
 * number because a prediction already showed it (`dedupe` = ack-confirmed
 * hitscan; `confirmed` = projectile now authoritative). `handleDamage`
 * stays the SOLE HP/HUD authority — only the number push is gated; HP,
 * shield, flash, healthbar, and hostility are all untouched. A
 * non-self-shooter or no-matching-prediction event returns `false`
 * (handleDamage behaves exactly as it does today).
 */
export function reconcileDamageToFeedback(
  ledger: HitPredictionLedger,
  damage: { targetId: string; damage: number },
  shooterIsSelf: boolean,
  nowMs: number,
): boolean {
  const r = ledger.reconcileDamage(damage, shooterIsSelf, nowMs);
  return r.kind === 'dedupe' || r.kind === 'confirmed';
}
