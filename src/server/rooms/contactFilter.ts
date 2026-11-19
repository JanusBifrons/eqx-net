import type { Contact } from '../../core/physics/contactDrain.js';
import type { MapSchema } from '@colyseus/schema';
import type { Bus } from '../../core/events/Bus.js';
import { aggregateRamming } from '../../core/combat/Ramming.js';
import { isLingeringHull } from '../../core/entity/shipLiveness.js';
import type { CollisionResolvedMessage } from '../../shared-types/messages.js';
import { wireShipBodyId } from '../../shared-types/shipBodyIds.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import type { CollisionBroadcastGate } from '../net/CollisionBroadcastGate.js';
import type { SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { LootSubsystem } from '../cargo/LootSubsystem.js';
import type { ContactPayload } from './PhysicsWorkerProxy.js';
import type { CutFieldSubsystem } from './CutFieldSubsystem.js';
import type { SceneWorkCounters } from './scene/SceneWorkCounters.js';
import type { ShipState } from './schema/SectorState.js';

/**
 * Phase 6b self-collision filter (2026-05-13).
 *
 * When a player has BOTH an active hull AND a lingering hull in the
 * same sector, the physics worker has two distinct Rapier rigid
 * bodies whose `resolveHandle` identity is the same string — both
 * are tagged with the player's `playerId`. Rapier reports the
 * inter-body contact correctly, but `aId === bId === playerId` on
 * the wire. The client's `applyCollisionResolved` iterates `[aId,
 * bId]` applying vA then vB to the SAME `predWorld` body — the
 * second iteration's velocity overrides the first, and the player's
 * local ship snaps to a velocity that came from one of the
 * participants but is wrong for either.
 *
 * Symptom: the user's active hull bouncing around their own parked
 * (lingering) hull with no visible attacker.
 *
 * The pure-function predicate below is the canonical guard. Inlined
 * in `handleContactBatch` (below) for the hot path; this predicate
 * exists so the contract is unit-testable + documented.
 *
 * This filter does NOT fix the server-side physics interaction —
 * the two bodies still collide and impart impulse on each other.
 * That deeper fix requires either:
 *   1. Distinct body identities (e.g. shipInstanceId, not playerId),
 *   2. Collision groups so the lingering body doesn't push the
 *      active body, or
 *   3. Removing the lingering body from the physics world entirely
 *      and only spawning a "ghost" sensor for hit-tests.
 *
 * Tracked in task #17.
 */
export function shouldBroadcastContact(c: Contact): boolean {
  return c.aId !== c.bId;
}

/** What the contact-batch handler needs from the room, built once in
 *  `spawnWorker`; getters read fields the room assigns later. */
export interface ContactBatchHost {
  sceneWork: Pick<SceneWorkCounters, 'active' | 'contacts'>;
  collisionGate: Pick<CollisionBroadcastGate, 'sweep' | 'shouldSend'>;
  cutField(): Pick<CutFieldSubsystem, 'onContact'> | undefined;
  bus(): Pick<Bus, 'emit'>;
  broadcast(type: 'collision_resolved', msg: CollisionResolvedMessage): void;
  disableCollisionDamage(): boolean;
  loot(): Pick<LootSubsystem, 'hullContact'>;
  applyDamage(targetId: string, shooterId: string, damage: number): boolean;
  swarmRegistry: Pick<SwarmEntityRegistry, 'get'>;
  lingeringSlots: ReadonlyMap<string, number>;
  ships(): Pick<MapSchema<ShipState>, 'get'>;
  getActiveShip(playerId: string): ShipState | undefined;
}

/**
 * The worker's per-tick CONTACT_BATCH: collision broadcast + ramming damage.
 * Moved verbatim out of `SectorRoom.spawnWorker`'s `onContactBatch`.
 */
export function handleContactBatch(h: ContactBatchHost, tick: number, contacts: ContactPayload[]): void {
    if (h.sceneWork.active) h.sceneWork.contacts += contacts.length;
    h.collisionGate.sweep(tick);
    // Stage 2 of the network-feel roadmap: each contact above the
    // worker's CONTACT_FORCE_FLOOR is broadcast to all clients in
    // the room as `collision_resolved`. AOI filter is deferred —
    // the typical 1–4 player room's per-tick contact volume is
    // low, and the client's `applyCollisionResolved` silently
    // no-ops on bodies its predWorld doesn't track. Bus emission
    // lets persistence/telemetry subscribe.
    //
    // Aggregate per unordered {aId,bId} pair FIRST. A hull-polygon
    // body is a compound of N triangle colliders, so one physical
    // ram emits up to N contact-force sub-events sharing aId/bId.
    // Summing before floor/damage/broadcast prevents N-multiplied
    // damage, sub-floor splitting, and one broadcast per triangle.
    // See src/core/combat/Ramming.ts.
    for (const p of aggregateRamming(contacts)) {
      // Phase 6b self-collision filter (aId === bId): the active +
      // lingering hulls of one player share the playerId identity.
      // See shouldBroadcastContact above for the rationale + its unit test.
      if (p.aId === p.bId) {
        serverLogEvent('collision_self_filtered', {
          aId: p.aId,
          tick,
          impulse: parseFloat(p.force.toFixed(3)),
        });
        continue;
      }
      h.cutField()?.onContact(p.aId, p.bId, p.normalSpeed, tick);
      h.bus().emit('COLLISION_RESOLVED', {
        type: 'COLLISION_RESOLVED',
        aId: p.aId,
        bId: p.bId,
        vA: p.vA,
        vB: p.vB,
        impulse: p.force,
        tick,
      });
      // Lasting contacts (ships pressed together) arrive every tick;
      // the client keeps at most a few a second, so only a pair's first
      // contact, an impact, or one every 150 ms goes out (the ram
      // damage below still sees every tick). See CollisionBroadcastGate.
      if (h.collisionGate.shouldSend(p.aId, p.bId, p.normalSpeed, tick)) {
        // eA/eB name each side as the client knows it, so it can draw a
        // shield contact on a raised shield (user report 2026-11-07).
        // Ids as the CLIENT keys bodies: a parked hull's `linger-<sid>`
        // worker body is the bare sid client-side (RTS Part A S3; the ONE
        // mapping, `wireShipBodyId`, #15).
        const msg: CollisionResolvedMessage = {
          type: 'collision_resolved',
          aId: wireShipBodyId(p.aId),
          bId: wireShipBodyId(p.bId),
          vA: p.vA,
          vB: p.vB,
          impulse: p.force,
          tick,
        };
        const eA = clientEntityCode(h, p.aId), eB = clientEntityCode(h, p.bId);
        if (eA !== undefined) msg.eA = eA;
        if (eB !== undefined) msg.eB = eB;
        h.broadcast('collision_resolved', msg);
        serverLogEvent('collision_resolved', {
          aId: p.aId,
          bId: p.bId,
          impulse: parseFloat(p.force.toFixed(3)),
          tick,
        });
      }
      // Ramming damage (impact-based model, 2026-11-13; see Ramming.ts).
      // Each side takes its OWN damage (normal-impact energy shared by
      // weight: equal ships equally, the lighter more); the OTHER id is the "shooter" (kill-feed + hostility
      // attribution). applyDamage already no-ops on asteroids (immune - no
      // swarmHealth entry), so "asteroids deal but do not take" still holds.
      // Applied once per pair per tick.
      // P3.3 — ROUND the damage BEFORE the guard so a fractional collision
      // (the post-WS-1 light-bump regime, e.g. 0.13) emits NOTHING. The old
      // guard tested the raw float `> 0`, so 0.13 passed → a DamageEvent
      // broadcast → the client drew impact sparks + a damage number that
      // rounded to "0" ("sparks and damage still show… it just now shows
      // 0s"). Gating on the ROUNDED value aborts the whole pipeline (no
      // applyDamage → no DamageEvent → no sparks) for any sub-0.5 hit, and
      // makes the applied damage match what the client displays.
      const damageA = Math.round(p.damageA);
      const damageB = Math.round(p.damageB);
      if ((damageA > 0 || damageB > 0) && !h.disableCollisionDamage()) {
        serverLogEvent('ram_damage', {
          aId: p.aId,
          bId: p.bId,
          force: parseFloat(p.force.toFixed(1)),
          impactSpeed: parseFloat(p.impactSpeed.toFixed(1)),
          normalSpeed: parseFloat(p.normalSpeed.toFixed(1)),
          damageA,
          damageB,
          tick,
        });
        if (damageA > 0 && !h.loot().hullContact(p.aId, p.bId)) h.applyDamage(p.aId, p.bId, damageA);
        if (damageB > 0 && !h.loot().hullContact(p.bId, p.aId)) h.applyDamage(p.bId, p.aId, damageB);
      }
    }
}

/** How the client knows a physics body: -1 = a ship, keyed as the client
 *  keys it (`wireShipBodyId`: an active pilot's playerId, or an AI-flown
 *  hull's bare sid), >= 0 = a swarm entity id, undefined = neither. */
function clientEntityCode(h: ContactBatchHost, id: string): number | undefined {
  const rec = h.swarmRegistry.get(id);
  if (rec) return rec.entityId;
  const wireId = wireShipBodyId(id);
  if (wireId !== id) {
    // A `linger-<sid>` body: an AI-flown (LINGERING) hull.
    const hull = h.lingeringSlots.has(wireId) ? h.ships().get(wireId) : undefined;
    return hull && isLingeringHull(hull) ? -1 : undefined;
  }
  return h.getActiveShip(id)?.isActive === true ? -1 : undefined;
}
