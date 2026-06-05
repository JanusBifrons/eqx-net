/**
 * Shared base for the client Entity leaves. Pulls the SIDE-NEUTRAL facts from
 * the core `EntityKindRegistry` (the single shared vocabulary): the pose-core
 * kind byte and `staticBody = !interpolated`. Owns the reused repose scratch so
 * static leaves re-pose with zero per-sync allocation (invariant #14).
 */
import { getEntityKind } from '@core/entity/EntityKindRegistry';
import type { EntityKindTag } from '@core/entity/Entity';
import type { ShipPhysicsState } from '@core/physics/World';
import type { IClientEntityLeaf, ClientSpawnCtx, ClientSyncCtx } from './IClientEntityLeaf.js';

export abstract class ClientEntityLeafBase implements IClientEntityLeaf {
  readonly poseCoreKind: number;
  /** True for asteroid / structure (locked + posed from the packet); false for
   *  the drone (the kinematic follower owns its pose). DERIVED from the core
   *  descriptor — never restated per leaf. */
  protected readonly staticBody: boolean;
  private readonly _poseScratch: ShipPhysicsState = {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    angvel: 0,
  };

  protected constructor(tag: EntityKindTag) {
    const d = getEntityKind(tag);
    if (d.sync.transport !== 'pose-core' || d.sync.poseCoreKind === undefined) {
      throw new Error(
        `ClientEntityLeaf: '${tag}' is not a pose-core kind (transport=${d.sync.transport})`,
      );
    }
    this.poseCoreKind = d.sync.poseCoreKind;
    this.staticBody = !d.sync.interpolated;
  }

  abstract spawnBody(ctx: ClientSpawnCtx): void;
  abstract onSync(ctx: ClientSyncCtx): void;

  /** Re-pose a static body from the raw packet pose (zero-alloc scratch).
   *  Behaviour-identical to the pre-refactor inline
   *  `setShipState({ x, y, vx, vy, angle, angvel })`. */
  protected repose(ctx: ClientSyncCtx): void {
    const s = this._poseScratch;
    s.x = ctx.entry.x;
    s.y = ctx.entry.y;
    s.vx = ctx.entry.vx;
    s.vy = ctx.entry.vy;
    s.angle = ctx.entry.angle;
    s.angvel = ctx.entry.angvel;
    ctx.predWorld.setShipState(ctx.key, s);
  }
}
