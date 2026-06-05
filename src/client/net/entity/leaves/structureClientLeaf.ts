/**
 * Structure (pose-core kind 2): a static, damageable world object. Client-side
 * it is asteroid-like — a CIRCULAR collider (no polygon, matching the
 * pre-refactor hand-wired `kind !== 0 ? undefined` branch) LOCKED in predWorld
 * and posed from the packet. No AI, no client shield layer. Damage is
 * server-authoritative through the existing swarm path (EntityResolver →
 * StructureEntity), so there is nothing damage-specific here — that is the
 * "structure for free" payoff (B5).
 */
import { ClientEntityLeafBase } from '../ClientEntityLeafBase.js';
import type { ClientSpawnCtx, ClientSyncCtx } from '../IClientEntityLeaf.js';

/** Structure predWorld mass — matches the pre-refactor hardcoded `3` for any
 *  non-drone kind. */
const STRUCTURE_MASS = 3;

export class StructureClientLeaf extends ClientEntityLeafBase {
  constructor() {
    super('structure');
  }

  spawnBody(ctx: ClientSpawnCtx): void {
    ctx.predWorld.spawnObstacle(
      ctx.key,
      ctx.entry.x,
      ctx.entry.y,
      ctx.entry.radius,
      STRUCTURE_MASS,
      undefined, // circular — matches the pre-refactor non-asteroid branch
    );
    ctx.predWorld.lockBody(ctx.key); // static server-side
  }

  onSync(ctx: ClientSyncCtx): void {
    this.repose(ctx);
  }
}
