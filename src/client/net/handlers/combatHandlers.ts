/**
 * Server → client combat messages: `damage` (prediction de-dupe, then the
 * HP/HUD authority `handleDamage`), `shield`, `destroy`, `hit_ack` (the single
 * hit-prediction reconcile path), remote `laser_fired` beams, the
 * `control_mode` command-view join and `bot_aggro` hostility. The state
 * changes themselves stay on ColyseusClient (`handleDamage` /
 * `handleShield` / `handleDestroy`); these are the wire-facing bodies.
 * zod-validated where the payload already parsed (#3/#4); pooled scratch,
 * no per-message allocation (#14).
 */
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { AiController } from '@core/ai/AiController';
import type { HitPredictionLedger } from '@core/combat/HitPrediction';
import type { DamageEvent, DestroyEvent, LaserFiredEvent, ShieldEventMessage, BotAggroEvent } from '@shared-types/messages';
import { HitAckSchema, DamageEventSchema } from '@shared-types/messages';
import { ControlModeMessageSchema } from '@shared-types/messages/snapshotMessages';
import type { WeaponMount } from '@shared-types/shipKinds';
import { logEvent } from '../../debug/ClientLogger';
import {
  reconcileAckToFeedback,
  reconcileDamageToFeedback,
  type ReconcileFeedbackSink,
} from '../../combat/HitPrediction.client';
import type { GhostManager } from '../../combat/GhostProjectile';
import { findMount, isSustainedBeamMount, remoteBeamTtlMs } from '../../render/beamStyles';
import type { DrawnShellTiming } from '../drawnShellTiming';
import { parseDestroy } from '../parseDestroy';

/** What the combat handlers touch on the client. */
export interface CombatHandlerCtx {
  readonly mirror: RenderMirror;
  readonly hitLedger: HitPredictionLedger;
  readonly reconcileSink: ReconcileFeedbackSink;
  readonly ghostManager: Pick<GhostManager, 'resolve'>;
  readonly shellTiming: Pick<DrawnShellTiming, 'onBeamFired'>;
  readonly aiController: Pick<AiController, 'markHostile'>;
  /** The injected clock's `now()` (ms). */
  now(): number;
  /** The client's current input tick. */
  inputTick(): number;
  handleDamage(evt: DamageEvent, suppressNumber: boolean): void;
  handleShield(evt: ShieldEventMessage): void;
  handleDestroy(evt: DestroyEvent): void;
  /** The mounts of the shooter's ship kind (remote beam TTL). */
  shooterKindMounts(shooterId: string): readonly WeaponMount[] | undefined;
  /** RTS slice 10 — enter command view on the server's say-so. */
  enterCommandFromServer(): void;
}

export function registerCombatHandlers(room: Room, ctx: CombatHandlerCtx): void {
  /** 2026-05-25 heap-growth gate step 8 — pooled `{targetId, damage}`
   *  literal for the per-damage-event reconcileDamageToFeedback call.
   *  Under 25-drone combat at ~75 hits/sec, the pre-fix per-event
   *  literal was a real allocator. Mutate the scratch each call. */
  const damageReconcileScratch: { targetId: string; damage: number } = { targetId: '', damage: 0 };
  /** 2026-05-26 heap-growth gate step 11 — pooled `{hit, targetId, damage}`
   *  literal for the per-hit_ack reconcileAckToFeedback call. Same shape
   *  as `damageReconcileScratch`: `PredictedAck` consumer reads the
   *  fields synchronously inside `HitPredictionLedger.reconcileAck` and
   *  never retains the reference (verified at HitPrediction.ts:142). */
  const hitAckReconcileScratch: { hit: boolean; targetId?: string; damage?: number } = { hit: false, targetId: undefined, damage: undefined };

  room.onMessage('damage', (raw: unknown) => {
    // weapon-hit-prediction Phase 3 — defensive zod parse on receive
    // (invariant #4; mirrors the collision_resolved drop-on-fail). The
    // client now CONSUMES this message for prediction de-dupe, so it
    // crosses the trust boundary.
    const parsed = DamageEventSchema.safeParse(raw);
    if (!parsed.success) return;
    const evt = parsed.data;
    // Single reconcile path: if a prediction already showed this number,
    // suppress handleDamage's duplicate. handleDamage stays the SOLE
    // HP/HUD authority — only the number push is gated.
    // step 8: pooled scratch (was per-event literal).
    damageReconcileScratch.targetId = evt.targetId;
    damageReconcileScratch.damage = evt.damage;
    const suppressNumber = reconcileDamageToFeedback(
      ctx.hitLedger,
      damageReconcileScratch,
      evt.shooterId === ctx.mirror.localPlayerId,
      ctx.now(),
    );
    ctx.handleDamage(evt, suppressNumber);
  });

  room.onMessage('shield', (evt: ShieldEventMessage) => {
    ctx.handleShield(evt);
  });

  // Defensive zod parse (invariant #3): malformed dropped with a sampled
  // warning; `vaporised` (fracture v11) rides into handleDestroy.
  room.onMessage('destroy', (raw: unknown) => {
    const evt = parseDestroy(raw);
    if (evt !== null) ctx.handleDestroy(evt);
  });

  room.onMessage('hit_ack', (raw: unknown) => {
    // weapon-hit-prediction Phase 3 — defensive zod parse (invariant #4;
    // the client now consumes hit_ack as its single reconcile path, so
    // it crosses the trust boundary). Drop-on-fail like collision_resolved.
    const parsed = HitAckSchema.safeParse(raw);
    if (!parsed.success) return;
    const ack = parsed.data;
    // THE single reconcile path — runs BEFORE ghostManager.resolve so a
    // mispredicted number is hard-cancelled the same frame the ghost
    // fades. resolve() itself is unchanged (still fades the ghost salvo
    // by clientShotId on the wire ack).
    // 2026-05-26 heap-growth gate step 11: pooled scratch instead of
    // a fresh `{hit, targetId, damage}` literal per hit_ack. Same
    // pattern as `damageReconcileScratch` (step 8) — the consumer
    // (`HitPredictionLedger.reconcileAck`, HitPrediction.ts:142)
    // reads fields synchronously and never retains the reference.
    hitAckReconcileScratch.hit = ack.hit;
    hitAckReconcileScratch.targetId = ack.targetId;
    hitAckReconcileScratch.damage = ack.damage;
    reconcileAckToFeedback(
      ctx.hitLedger,
      ack.clientShotId,
      hitAckReconcileScratch,
      ctx.reconcileSink,
      ctx.now(),
    );
    ctx.ghostManager.resolve(ack.clientShotId, ack.hit);
    if (ack.rejected) {
      // Surface rejection events in the diagnostic ring buffer. The 2026-05-06
      // cooldown-restore bug ("most/all of my shots are rejected") was diagnosed
      // by inference because no fire/hit_ack events were ever logged. Future
      // captures of similar issues should now show the rejection cluster
      // directly.
      logEvent('fireRejected', { clientShotId: ack.clientShotId, hit: ack.hit, targetId: ack.targetId });
      // The raw 'shot_rejected' id is a diagnostic, not a player message —
      // it stays in the log only.
    }
  });

  room.onMessage('laser_fired', (evt: LaserFiredEvent) => {
    ctx.shellTiming.onBeamFired(evt);
    // Own shots are already shown as liveBeams — only store remote ones.
    if (evt.shooterId === ctx.mirror.localPlayerId) return;
    const dx = evt.toX - evt.fromX;
    const dy = evt.toY - evt.fromY;
    const range = Math.hypot(dx, dy);
    // Upsert: replaces the previous beam from this (shooter, mount) so
    // there is never more than one entry per mount and the TTL resets on
    // each shot. Player beams are HELD weapons (cooldown 167 ms at 60 Hz;
    // TTL 400 ms keeps the visual continuous while space is held).
    //
    // For AI shooters (`swarm-${entityId}`) the iteration we converged on:
    //   - First attempt 400 ms: the beam endpoints were stamped at fire time
    //     and stayed frozen, but the drone moved underneath, so each new
    //     fire teleported the beam origin → "jittery and laggy" (5c smoke).
    //   - Second attempt 80 ms: gave a discrete flash, but cooldown is 167 ms,
    //     so there's an 87 ms gap between flashes → visible flicker.
    //   - Settled: 250 ms TTL (overlaps cooldown by ~83 ms, no gap) AND the
    //     renderer re-derives the beam ORIGIN from `mirror.swarm[entityId]`
    //     each frame so it tracks the moving drone smoothly. Same pattern
    //     player beams use against `mirror.ships[localId]`.
    //
    // Multi-mount/turret refactor (Phase 2c): keyed by (shooterId, mountId).
    // Pre-2c servers omit `mountId`; we synthesise `'forward'` so the entry
    // still has a stable key and legacy single-mount rendering is unchanged.
    const isAiShooter = evt.shooterId.startsWith('swarm-');
    const mountKey = evt.mountId ?? 'forward';
    // The capital heavy beam (cooldown 10 ticks) holds longer so it reads as
    // one continuous burn, not a strobe (beamStyles `remoteBeamTtlMs`). Its
    // mount is looked up on the shooter's kind: no wire field.
    const ttlMs = remoteBeamTtlMs(isAiShooter, isSustainedBeamMount(findMount(ctx.shooterKindMounts(evt.shooterId), evt.mountId)));
    const lasers = (ctx.mirror.remoteLasers ??= new Map());
    let perShooter = lasers.get(evt.shooterId);
    if (!perShooter) {
      perShooter = new Map();
      lasers.set(evt.shooterId, perShooter);
    }
    // 2026-05-25 heap-growth gate step 7: pool the per-fire entry.
    // Pre-fix this handler allocated a fresh 8-field object literal
    // per drone fire (~150 allocs/sec under 25-drone combat).
    // Isolation experiment 2026-05-25 showed the 3 message handlers
    // (swarm/damage/laser_fired) drive 0.435 MB/s heap growth +
    // 80% of major-GC stalls. Reusing the entry object per
    // (shooter, mount) is safe — the renderer reads fields
    // synchronously each frame; upsert semantics are preserved.
    const expiresAt = ctx.now() + ttlMs;
    const existing = perShooter.get(mountKey);
    if (existing) {
      existing.range = range;
      existing.hit = evt.hit;
      existing.targetId = evt.targetId;
      existing.expiresAt = expiresAt;
      existing.fromX = evt.fromX;
      existing.fromY = evt.fromY;
      existing.toX = evt.toX;
      existing.toY = evt.toY;
    } else {
      perShooter.set(mountKey, {
        range,
        hit: evt.hit,
        targetId: evt.targetId,
        expiresAt,
        fromX: evt.fromX,
        fromY: evt.fromY,
        toX: evt.toX,
        toY: evt.toY,
      });
    }
  });

  // RTS slice 10 — a command-view join: the server parked our hull at the
  // arrival flip. Enter command view now (the snapshot carries the parked
  // hull as lingering, #16; this only makes the flip immediate). zod (#3).
  room.onMessage('control_mode', (raw: unknown) => {
    const parsed = ControlModeMessageSchema.safeParse(raw);
    if (!parsed.success || parsed.data.mode !== 'command') return;
    ctx.enterCommandFromServer();
  });

  // Living World — server→client twin of the damage→markHostile mirror.
  // When the director makes a bot proactively hostile to a player, the
  // server marks its own HostileDroneBehaviour AND broadcasts this; the
  // client feeds it into ITS predicted AiController so the in-interest
  // drone's predicted brain matches the authoritative one (no
  // swarm-wire bump — the existing, proven hostility channel). The
  // client AiController is keyed on the bare numeric entity id (see the
  // damage handler), so strip the `swarm-` prefix exactly as that path
  // does. A dropped packet self-heals on the next director re-mark.
  room.onMessage('bot_aggro', (evt: BotAggroEvent) => {
    if (!evt.botEntityId.startsWith('swarm-') || !evt.targetPlayerId) return;
    const numeric = evt.botEntityId.slice('swarm-'.length);
    ctx.aiController.markHostile(numeric, evt.targetPlayerId, ctx.inputTick());
  });
}
