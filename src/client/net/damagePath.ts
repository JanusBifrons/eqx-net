/**
 * The client's damage and death path: `shield` / `damage` state (HUD stash,
 * the predWorld collider swap, every ship's `shieldDown` bit, drone
 * hostility), the damage FX (flash, floating number, health-bar hit, impact
 * spark), and the one way an entity leaves the simulation (`killEntity`,
 * `killSwarmEntity`, via `handleDestroy`). `handlers/combatHandlers.ts` is the
 * wire side; `ColyseusClient` keeps one-line delegates and builds the
 * `DamagePathCtx` once (#14). Runs per event: allocates nothing new.
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { Clock } from '@core/clock/Clock';
import type { PhysicsWorld } from '@core/physics/World';
import type { AiController } from '@core/ai/AiController';
import type { DamageEvent, DestroyEvent, ShieldEventMessage } from '@shared-types/messages';
import { getShipKind } from '@shared-types/shipKinds';
import type { GhostManager } from '../combat/GhostProjectile';
import { useUIStore } from '../state/store';
import { logEvent } from '../debug/ClientLogger';
import { shouldEnterSpectatorOnDeath } from '../spectator/spectatorMode.js';
import { isNoDamageNumberTarget, isUnseenSwarmTarget, isWreckPieceTarget } from './damageNumberTargets.js';
import type { HudDispatcher } from './HudDispatcher.js';
import type { DrawnShellTiming } from './drawnShellTiming';
import type { NavalHitHold, HeldDamageSink } from './navalHitHold';
import type { ScheduledDamageSpawn } from './mirror/mirrorPassCtx.js';

/** What the damage path reads from / writes on `ColyseusClient`. Built ONCE
 *  (#14): reassigned fields are getters (setters where the path writes them). */
export interface DamagePathCtx {
  readonly mirror: RenderMirror;
  readonly clock: Clock;
  readonly predWorld: PhysicsWorld | null;
  readonly hudDispatcher: HudDispatcher;
  readonly aiController: Pick<AiController, 'markHostile'>;
  readonly inputTick: number;
  readonly shellTiming: DrawnShellTiming;
  readonly damageFlashFrames: Map<string, number>;
  readonly scheduledDamageSpawns: ScheduledDamageSpawn[];
  readonly navalHitHold: NavalHitHold;
  readonly heldDamageSink: HeldDamageSink;
  readonly ghostManager: Pick<GhostManager, 'clearForShip'>;
  readonly predSwarmKeys: Set<string>;
  readonly movingSwarmKeys: Set<string>;
  readonly welcomePerfNow: number;
  localDead: boolean;
  diedAtMs: number;
  /** THE remote-ship removal (`ColyseusClient.dropRemoteShip`). */
  dropRemoteShip(key: string): void;
}

/**
 * Discrete shield-state transition (Phase 3b). Sets the local
 * shieldPct anchor; the HUD bar tweens between anchors via CSS. On
 * 'restored' the local predWorld collider swaps back to the cheap
 * circle (authoritative; client never computes the 0-cross).
 */
export function handleShield(ctx: DamagePathCtx, evt: ShieldEventMessage): void {
  // M8 (plan wiggly-puppy): handleShield ONLY receives 'restored' /
  // 'regen_complete' events (never 'broken' — the 0-cross is carried
  // by DamageEvent.newShield=0 and handled in handleDamage). So any
  // event here means the shield is back UP. Mirror the bit for ANY
  // target so the shield aura updates remote ships too.
  const targetEntry = ctx.mirror.ships.get(evt.targetId);
  if (targetEntry && targetEntry.shieldDown !== false) {
    targetEntry.shieldDown = false;
  }

  if (evt.targetId !== ctx.mirror.localPlayerId) return;
  const pct = evt.shieldMax > 0 ? Math.round((evt.shield / evt.shieldMax) * 100) : 0;
  // step 10: stash for the 1Hz dispatcher; CSS bar animates between.
  ctx.hudDispatcher.stashShield(pct);
  if (evt.phase === 'restored' && ctx.predWorld?.hasShip(evt.targetId)) {
    ctx.predWorld.setHullExposed(evt.targetId, false, getShipKind(ctx.mirror.ships.get(evt.targetId)?.kind ?? null));
  }
}

export function handleDamage(ctx: DamagePathCtx, evt: DamageEvent, suppressNumber = false): void {
  // Campaign 1.2 — a 0-damage event is a STATE carrier only (the server
  // emits one solely for a shield 0-cross or a destruction; this is also
  // defense-in-depth against fractional damage from a pre-guard server).
  // State below (HUD stash, collider swap, shieldDown bit, hostility)
  // still applies; the FX pipeline (flash / floating number / health-bar
  // hit / impact spark) is gated so the player never sees a "0" + sparks.
  const showFx = evt.damage > 0;
  const localId = ctx.mirror.localPlayerId;
  if (evt.targetId === localId) {
    // Phase 7 — use the event-provided PER-KIND maxes, not the global
    // SHIP_MAX_HEALTH constant (the latent bug: a kind whose maxHealth
    // != 500 rendered a wrong %). newHealth is the HULL value.
    const hullPct = evt.hullMax > 0 ? Math.round((evt.newHealth / evt.hullMax) * 100) : 0;
    const shPct = evt.shieldMax > 0 ? Math.round((evt.newShield / evt.shieldMax) * 100) : 0;
    // step 10: just stash the latest target value; the 1Hz dispatcher
    // in updateMirror() pushes to Zustand. Bar's 1s CSS transition
    // animates smoothly between samples.
    ctx.hudDispatcher.stashHull(hullPct);
    ctx.hudDispatcher.stashShield(shPct);
    // Authoritative shield break -> mirror the collider swap into the
    // local predWorld so client hit/ramming prediction matches the
    // server. The client NEVER computes the 0-cross (reacts to the
    // authoritative event only — no predict-flap).
    if (evt.newShield === 0 && ctx.predWorld?.hasShip(localId)) {
      ctx.predWorld.setHullExposed(localId, true, getShipKind(ctx.mirror.ships.get(localId)?.kind ?? null));
    }
  }
  // Shield-layer hit → flag the target's shield-down state in the
  // mirror (M8 wiggly-puppy). The handleShield event is local-only
  // (line 1479 returns when targetId !== localPlayerId), but every
  // DamageEvent carries `newShield` for every target — so this is the
  // single ownership site for ALL ships' shieldDown bit. The
  // shieldDown=false case (regen back above 0) lands in handleShield
  // for the local player; remote players' regen ramps don't broadcast,
  // so a remote ship's ring will linger UP until its next DamageEvent
  // — accepted limitation, documented in src/client/CLAUDE.md Effects
  // section.
  const targetEntry = ctx.mirror.ships.get(evt.targetId);
  if (targetEntry) {
    const wasDown = targetEntry.shieldDown === true;
    const isDown = evt.newShield <= 0;
    if (isDown !== wasDown) targetEntry.shieldDown = isDown;
  }

  // Phase 1 AI: mirror the server's hostility-marking on every damage
  // event for swarm targets. Server fires the same call from its own
  // `applyDamage`. Both sides receive identical events so each drone's
  // per-instance `hostileTo` set converges without a wire-format bump.
  // Client AI controller is keyed on the bare numeric id (see register
  // call `\`${entityId}\``), so strip the `swarm-` prefix here.
  if (evt.targetId.startsWith('swarm-') && evt.shooterId) {
    const numeric = evt.targetId.slice('swarm-'.length);
    ctx.aiController.markHostile(numeric, evt.shooterId, ctx.inputTick);
  }

  // Visuals (flash / number / health bar / spark). A naval shell hit waits
  // for the frame its shell's burst is drawn at the display tick, so the
  // flash coincides with the drawn impact instead of leading it by the
  // display delay + RTT/2 (navalHitHold.ts). State above is never held.
  if (!showFx) return;
  if (ctx.shellTiming.holdHit(evt, suppressNumber)) return;
  applyDamageFx(ctx, evt, suppressNumber);
}

/** The FX half of a damage event with positive damage: hull flash,
 *  floating number, health-bar hit, impact spark. */
export function applyDamageFx(ctx: DamagePathCtx, evt: DamageEvent, suppressNumber: boolean): void {
  const localId = ctx.mirror.localPlayerId;
  // Flash the damaged ship for 6 frames.
  ctx.damageFlashFrames.set(evt.targetId, 6);
  // Debris (a wreck piece): spark and flash only, no number or health bar.
  const debris = isWreckPieceTarget(evt.targetId, ctx.mirror.swarm);

  // Floating damage number at hit location. weapon-hit-prediction
  // Phase 3 — suppressed when a confirmed/settled prediction already
  // showed this number (de-dupe: exactly one number per confirmed hit).
  // Everything else in handleDamage stays unconditional — this remains
  // the SOLE HP/HUD/flash/healthbar/hostility authority.
  // A swarm target the client never drew (spawned and killed between two
  // snapshots: the salvage pod a beam wore out of a wreck piece and burned
  // with its next pulse) gets no number: it would float over empty space.
  const targetShip = ctx.mirror.ships.get(evt.targetId);
  const unseen = targetShip === undefined && isUnseenSwarmTarget(evt.targetId, ctx.mirror.swarm);
  if (!suppressNumber && !debris && !unseen && !isNoDamageNumberTarget(evt.targetId, ctx.mirror.swarm) && ctx.mirror.pendingDamageNumbers) {
    const x = evt.hitX ?? targetShip?.x ?? 0;
    const y = evt.hitY ?? targetShip?.y ?? 0;
    ctx.mirror.pendingDamageNumbers.push({ targetId: evt.targetId, x, y, damage: evt.damage });
  }

  // Health bar on hit — only show for targets the local player is shooting.
  // Push BOTH hull% AND shield% so HealthBarManager can render a
  // two-segment bar. Without the shield half, shield damage on drones
  // looks like zero damage: the hull bar stays at 100% while shield
  // absorbs (no-spillover) the first N hits, and drones have no other
  // shield-feedback surface (only player ships have a HUD ShieldHullBar).
  if (evt.shooterId === localId && !debris && ctx.mirror.pendingHealthBarHits) {
    const healthPct = evt.hullMax > 0 ? Math.max(0, evt.newHealth / evt.hullMax) : 0;
    const shieldPct = evt.shieldMax > 0 ? Math.max(0, evt.newShield / evt.shieldMax) : 0;
    // Pre-hit HULL fraction for the chip-damage band: a HULL hit removed
    // `damage` from hull, so health was `newHealth + damage` before it. A
    // SHIELD hit left hull untouched ⇒ pre == post (no chip). All
    // client-derived from the already-received DamageEvent — no wire cost.
    const preHealthPct =
      evt.hullMax > 0 && evt.hitLayer === 'hull'
        ? Math.min(1, (evt.newHealth + evt.damage) / evt.hullMax)
        : healthPct;
    ctx.mirror.pendingHealthBarHits.push({ entityId: evt.targetId, healthPct, shieldPct, preHealthPct });
  }

  // Impact sparks — visual-effects subsystem M7 (plan wiggly-puppy).
  // Push to the pending queue; the renderer drains it inside update()
  // on shouldRender frames (perFrameTriggers gate). Authoritative-only
  // on first pass per the plan's asymmetry with damage numbers
  // (predicted hits get the number immediately but sparks follow the
  // server's DamageEvent — RTT/2 lag is acceptable for the decorative
  // spark vs the load-bearing damage number).
  if (ctx.mirror.pendingEffectTriggers) {
    const targetShipForFallback = ctx.mirror.ships.get(evt.targetId);
    const sparkX = evt.hitX ?? targetShipForFallback?.x ?? 0;
    const sparkY = evt.hitY ?? targetShipForFallback?.y ?? 0;
    const tint = evt.hitLayer === 'shield' ? 0x88ddff : 0xff8844;
    ctx.mirror.pendingEffectTriggers.push({
      kind: 'impact',
      worldX: sparkX,
      worldY: sparkY,
      tint,
      entityId: evt.targetId, // for shield-ring pulse on shield-layer hits
    });
  }
}

/**
 * Single authoritative path for removing any entity from the simulation.
 * Called immediately on destroy event for both local and remote ships.
 * syncMirror acts as a defensive fallback only.
 */
export function killEntity(ctx: DamagePathCtx, id: string): void {
  // Trigger explosion sprite on this frame (renderer consumes then App.tsx clears).
  ctx.mirror.explodingShips?.add(id);
  flushQueuedDamageFx(ctx, id);

  // Immediately remove physics body so hitscan and collisions cannot hit it.
  ctx.predWorld?.despawnShip(id);

  // Remove from render mirror so the sprite is culled this frame.
  ctx.mirror.ships.delete(id);

  if (id === ctx.mirror.localPlayerId) {
    ctx.localDead = true;
    ctx.diedAtMs = ctx.clock.now();
    // Plan: crispy-kazoo, Commit 3 — death is the cascade trigger.
    // Pre-Commit 3 the capture lifecycle.ndjson had ZERO local_died
    // events; we reconstructed death from indirect breadcrumbs
    // (GalaxyOverviewScreen mount in 'spawn' mode). This event lets
    // future captures measure death-to-respawn directly.
    const msSinceWelcome = ctx.welcomePerfNow > 0
      ? Math.round(ctx.diedAtMs - ctx.welcomePerfNow)
      : -1;
    logEvent('local_died', { playerId: id, msSinceWelcome });
    ctx.mirror.liveBeams?.clear();
    ctx.ghostManager.clearForShip(id);
    useUIStore.getState().setHullPct(0);
    // Phase 4 WS-A1 (D3) — death transitions INSTANTLY into spectator (no
    // death modal). The old blocking DeathOverlay path is removed; the player
    // free-roams the sector as an invulnerable, un-networked camera with full
    // construction. `isDead` is intentionally NOT set (it gated the modal);
    // `pilotMode='spectator'` is the discrete flag the camera/input/build
    // branches read. Remote interpolation keeps running so drones stay smooth.
    // RTS slice 10: that IS command view (`selectControlMode` → 'command'),
    // a free camera over the rest of the fleet, never a dead-hull follow.
    if (shouldEnterSpectatorOnDeath(id, ctx.mirror.localPlayerId)) {
      useUIStore.getState().setPilotMode('spectator');
    }
    useUIStore.getState().setSectorAlert('SHIP DESTROYED');
    setTimeout(() => useUIStore.getState().setSectorAlert(null), 3000);
  } else {
    ctx.dropRemoteShip(id);
  }
}

export function handleDestroy(ctx: DamagePathCtx, evt: DestroyEvent): void {
  const vaporised = evt.vaporised === true;
  // Held for its drawn shell: the release marks it vaporised in its frame.
  if (ctx.shellTiming.deferKill(evt.targetId, vaporised)) return;
  // A cut kill that left no wreck piece (fracture v11): the renderer plays
  // the vaporise blast and holds no dying hull. Same key as explodingShips.
  if (vaporised) ctx.mirror.vaporisedShips?.add(evt.targetId);
  if (evt.targetId.startsWith('swarm-')) killSwarmEntity(ctx, evt.targetId);
  else killEntity(ctx, evt.targetId);
}

/**
 * Remove a swarm entity (drone) immediately on a destroy event. Sweeps the
 * mirror entry, the predWorld body, and the damage-flash tracker. The next
 * binary swarm packet will confirm the entity is gone (delta packets won't
 * mention it; the next 60-tick full snapshot will sweep on the server's say-so).
 */
export function killSwarmEntity(ctx: DamagePathCtx, wireId: string): void {
  const entityIdStr = wireId.slice('swarm-'.length);
  const entityId = parseInt(entityIdStr, 10);
  if (Number.isNaN(entityId)) return;
  ctx.mirror.swarm?.delete(entityId);
  if (ctx.predWorld?.hasShip(wireId)) ctx.predWorld.despawnShip(wireId);
  ctx.predSwarmKeys.delete(wireId);
  ctx.movingSwarmKeys.delete(wireId);
  ctx.damageFlashFrames.delete(wireId);
  // Reuse the explosion sprite path — the renderer keys explosions off
  // sprite position (looked up by id), and `swarm-${entityId}` is the
  // sprite key, so the existing explosion machinery just works.
  ctx.mirror.explodingShips?.add(wireId);
  flushQueuedDamageFx(ctx, wireId);
  useUIStore.getState().setSwarmCount(ctx.mirror.swarm?.size ?? 0);
}

/**
 * The target just died: release, NOW, every hit visual still queued for
 * it, so its number completes in the explosion's frame and never climbs
 * over the wreck afterwards (fight-clip review 2026-11-13). Two queues
 * delay a real hit's number on purpose: the smooth-beam splits of a
 * predicted hitscan hit, and naval hits held for their drawn shell burst.
 * The hits were dealt before the death, so they are flushed, not dropped;
 * the renderer then closes the number (`DamageNumberManager.markDead`, fed
 * by the same `explodingShips` frame). Rare path (a death).
 */
export function flushQueuedDamageFx(ctx: DamagePathCtx, targetId: string): void {
  const scheduled = ctx.scheduledDamageSpawns;
  if (scheduled.length > 0) {
    const pending = ctx.mirror.pendingDamageNumbers;
    // Forward, so the splits land in schedule order.
    let w = 0;
    for (let r = 0; r < scheduled.length; r++) {
      const s = scheduled[r]!;
      if (s.targetId === targetId) {
        pending?.push({ targetId: s.targetId, x: s.x, y: s.y, damage: s.damage, tag: s.tag });
      } else {
        scheduled[w++] = s;
      }
    }
    scheduled.length = w;
  }
  if (ctx.navalHitHold.size > 0) {
    ctx.navalHitHold.flushTarget(targetId, ctx.heldDamageSink);
  }
}
