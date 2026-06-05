/**
 * Drone (pose-core kind 1): a circular, UNLOCKED predWorld body whose mass is
 * the ship-kind catalogue mass — so the client/server impulse distribution
 * against the player's ship matches (the 2026-05-28 mass-match fix; pre-fix a
 * hardcoded `3` gave a Crossguard a 1:3 client ratio vs 1:30 server, feeding a
 * drift correction every snapshot). Locking client-only would diverge from the
 * server (player bounces off a locked drone client-side; server says it moves)
 * so the reconciler would constantly snap — drones stay dynamic.
 *
 * Registers a `HostileDroneBehaviour` in the client hostility LEDGER (never
 * ticked post the 2026-05-18 drone-snapshot-interpolation pivot — it is read by
 * `isEntityHostileToPlayer` for HaloRadar threat colour), and swaps its shield
 * collider on the authoritative shield-down bit.
 *
 * NOT posed in `spawnBody` / `onSync`: the drone's predWorld body is a KINEMATIC
 * follower driven each frame by `ColyseusClient.updateMirror` at the single
 * interpolated pose (the one-pose-per-frame rule). Re-posing here would be a
 * second, fighting correction path (the 2026-05-19 jitter bug class).
 */
import { getShipKind } from '@shared-types/shipKinds';
import { HostileDroneBehaviour } from '@core/ai/HostileDroneBehaviour';
import { ClientEntityLeafBase } from '../ClientEntityLeafBase.js';
import type { ClientSpawnCtx, ClientSyncCtx } from '../IClientEntityLeaf.js';

/** Fallback mass when the catalogue lookup yields no mass (defensive — matches
 *  the pre-refactor `?? 3`). */
const DRONE_FALLBACK_MASS = 3;

export class DroneClientLeaf extends ClientEntityLeafBase {
  constructor() {
    super('drone');
  }

  spawnBody(ctx: ClientSpawnCtx): void {
    const kind = getShipKind(ctx.entry.shipKind ?? null);
    // Circular collider (no vertices), catalogue mass, UNLOCKED.
    ctx.predWorld.spawnObstacle(
      ctx.key,
      ctx.entry.x,
      ctx.entry.y,
      ctx.entry.radius,
      kind.mass ?? DRONE_FALLBACK_MASS,
      undefined,
    );
    // Hostility ledger only (brain never ticked client-side). The caller folds
    // `registeredAiId` into `_aiRegisteredIds` (single cache ownership).
    ctx.aiController.register(`${ctx.entityId}`, ctx.entityId, new HostileDroneBehaviour(kind));
    ctx.registeredAiId = ctx.entityId;
    // NOTE: the FIRST shield swap happens in onSync (which runs immediately
    // after spawnBody on the same sync), NOT here — so setHullExposed is called
    // exactly once per sync, byte-identical to the pre-refactor every-sync block.
  }

  onSync(ctx: ClientSyncCtx): void {
    // Drive the drone hull-collider swap from the SINGLE authoritative
    // shield-down field. `setHullExposed` is idempotent, so calling it every
    // sync is cheap. ONE ownership site — no second correction path (chapter-2).
    ctx.predWorld.setHullExposed(
      ctx.key,
      ctx.entry.shieldDown ?? false,
      getShipKind(ctx.entry.shipKind ?? null),
    );
  }
}
