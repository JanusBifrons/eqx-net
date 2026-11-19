/**
 * Living World P1a — loot pods + fly-over pickup + spill-on-death. Builds the
 * room's `LootSubsystem`: how a pod rides the swarm (spawn, despawn, re-tint,
 * live pose), who collects, the tractor hold zone and the wreck-piece store.
 * Moved verbatim out of `SectorRoom.onCreate`, which calls it at the same point.
 *
 * Pods are scrap-kind swarm entities (parentShipKind 'cargo-pod',
 * componentIndex = glow tier) spawned DIRECTLY (never through the
 * ScrapSpawner FIFO, whose eviction would delete value) and persisted only
 * via the holds table (never the sector snapshot) — hostile-review A3.
 */
import { LootSubsystem, type PodPose } from '../../cargo/LootSubsystem.js';
import type { LootCollectors } from '../../cargo/LootCollectors.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { SwarmSpawner } from '../../spawn/SwarmSpawner.js';
import type { ForceFieldSubsystem } from '../ForceFieldSubsystem.js';
import type { CapitalWreckSubsystem } from '../CapitalWreckSubsystem.js';
import type { OreDraw } from '../OreDraw.js';
import { getHoldStore } from '../../db/PersistenceWorker.js';
import { auditEvent } from '../../audit/GameplayAuditLog.js';
import { scrapColliderFor } from '../../../core/geometry/scrapCollider.js';
import { holdWeight } from '../../../core/cargo/hold.js';
import { slotBase, SLOT_X_OFF, SLOT_Y_OFF } from '../../../shared-types/sabLayout.js';

/** What building the room's loot pods needs; getters read the live field. */
export interface LootPodsHost {
  sectorKey(): string | null;
  /** Test rooms only (`roomOpts.keepAllOnDeath` in test mode). */
  keepAllOnDeath: boolean;
  now(): number;
  swarmRegistry: Pick<SwarmEntityRegistry, 'has' | 'get'>;
  swarmSpawner(): Pick<SwarmSpawner, 'spawnScrap'>;
  evictSwarmEntity(rec: SwarmEntityRecord, opts: { broadcast: boolean; emitDestroyed: boolean }): void;
  sabF32(): Float32Array;
  lootCollectors: Pick<LootCollectors, 'forEach' | 'fill' | 'onLootCollected'>;
  forceFields: Pick<ForceFieldSubsystem, 'inTractorHold' | 'tractorCount' | 'forEachHeldPiece'>;
  capitalWrecks(): Pick<CapitalWreckSubsystem, 'liveCount' | 'forEachPieceNear' | 'pieceStore' | 'storePiece'> | null;
  oreDraw: Pick<OreDraw, 'chunkYield'>;
}

export function buildLootPods(h: LootPodsHost): LootSubsystem {
  const podPoseScratch: PodPose = { x: 0, y: 0 };
  return new LootSubsystem({
    holdStore: getHoldStore(),
    sectorKey: () => h.sectorKey(),
    ...(h.keepAllOnDeath ? { keepAllOnDeath: true } : {}),
    now: () => h.now(),
    spawnPodEntity: (id, x, y, vx, vy, tier) => {
      if (h.swarmRegistry.has(id)) return false;
      const geom = scrapColliderFor('cargo-pod', tier);
      if (geom === null) return false;
      // No health entry: a pod is immune to damage, like an asteroid
      // (`swarmHealthBinding` → `applied: false`; owner 2026-11-17).
      return h.swarmSpawner().spawnScrap({
        id, x, y, vx, vy, angle: 0, radius: geom.radius,
        parentShipKind: 'cargo-pod', componentIndex: tier, vertices: geom.vertices,
      });
    },
    despawnPodEntity: (id) => {
      const rec = h.swarmRegistry.get(id);
      if (rec) h.evictSwarmEntity(rec, { broadcast: true, emitDestroyed: false });
    },
    setPodTier: (id, tier) => {
      const rec = h.swarmRegistry.get(id);
      if (rec) rec.componentIndex = tier;
    },
    podPose: (id) => {
      const rec = h.swarmRegistry.get(id);
      if (rec == null) return null;
      const b = slotBase(rec.slot);
      const p = podPoseScratch;
      const sab = h.sabF32();
      p.x = sab[b + SLOT_X_OFF]!;
      p.y = sab[b + SLOT_Y_OFF]!;
      return p;
    },
    forEachCollector: (visit) => h.lootCollectors.forEach(visit), fillCollector: (id, c) => h.lootCollectors.fill(id, c),
    // Tractor hold zone (emitter id: a pilot's playerId or an AI ship's swarm id): a pod is picked up, a wreck piece stored whole; a consumable piece near the hull too.
    inTractorHold: (c, podId, x, y) => h.forceFields.inTractorHold(c.playerId, podId, x, y),
    heldPieces: { any: () => h.forceFields.tractorCount > 0 || (h.capitalWrecks()?.liveCount() ?? 0) > 0, forEach: (c, visit) => h.forceFields.forEachHeldPiece(c.playerId, visit), near: (x, y, reach, maxM, visit) => h.capitalWrecks()?.forEachPieceNear(x, y, reach, maxM, visit), store: (id, out) => h.capitalWrecks()?.pieceStore(id, out) === true, remove: (id) => h.capitalWrecks()?.storePiece(id) },
    chunkOre: (ore, x, y, weight) => h.oreDraw.chunkYield(ore.rockId, x, y, weight, ore.resource),
    onCollected: (c, moved, podId) => h.lootCollectors.onLootCollected(c, moved, podId),
    onDropped: (podId, hold, cause) => auditEvent({ event: 'loot_dropped', sector: h.sectorKey() ?? undefined, podId, cause, weight: holdWeight(hold) }),
    onDestroyed: (podId, hold, cause) => auditEvent({ event: 'loot_destroyed', sector: h.sectorKey() ?? undefined, podId, cause, weight: holdWeight(hold) }),
  });
}
