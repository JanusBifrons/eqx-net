import RAPIER from '@dimforge/rapier2d-compat';
import { wallGeometry } from '../structures/ShieldWall.js';

/** One `PhysicsWorld`'s shield-wall spans (its `walls`): the world's
 *  `spawnWall` / `setWallActive` / `removeWall` delegate here, and its
 *  `hitscan` passes `wallHandleToId` to `castHitscan`. */
export class ShieldWallBodies {
  /** Shield-wall span bodies + colliders, keyed by wall id. Kept SEPARATE from
   *  `PhysicsWorld.bodies` (and out of its `handleToId`) so walls never enter the
   *  ship/obstacle SAB-write + contact iteration (`getAllShipStates`): they are
   *  static, slot-less, pose-broadcast-free obstacles whose only job is to block
   *  ships. The collider ref is kept so the wall toggles (stun / power loss) via
   *  `setEnabled` without re-spawning the body. */
  private readonly wallBodies = new Map<string, RAPIER.RigidBody>();
  private readonly wallColliders = new Map<string, RAPIER.Collider>();
  /** Wall-body Rapier handle → `wall-${id}` sentinel. Walls are kept out of
   *  `handleToId` (above), but a hitscan beam must still TERMINATE at an up
   *  wall (R2.28 — the client predicted beam previously ran through it because
   *  `castHitscan` resolved only via `handleToId`). Consulted ONLY in
   *  `castHitscan`'s miss-fallback so a wall contact can never mis-resolve to a
   *  ship id elsewhere. Cleared in `removeWall`; a disabled (down) wall is
   *  excluded from `castRay` by Rapier so it stays passable without a map edit. */
  readonly wallHandleToId = new Map<number, string>();

  constructor(private readonly world: RAPIER.World) {}

  /**
   * Spawn a shield-wall span — a STATIC (fixed) cuboid spanning between two pylon
   * poses (shield-fence plan). It blocks ships physically (an immovable body the
   * dynamic ship bodies bounce off); weapon absorption is resolved main-thread
   * (the server has no live Rapier world). The geometry is derived from the two
   * poses via the shared `wallGeometry` so the server collider, the client
   * predWorld collider, and the rendered span all agree. Idempotent on `id`.
   *
   * NOT given CONTACT_FORCE_EVENTS — a wall never deals ram damage; it just
   * blocks. Toggle it on stun / power loss via `setWallActive` (cheaper than a
   * despawn/respawn churn of the body + handle maps).
   */
  spawnWall(id: string, ax: number, ay: number, bx: number, by: number, thickness: number): void {
    if (this.wallBodies.has(id)) return;
    const g = wallGeometry(ax, ay, bx, by);
    if (g.length < 1) return; // degenerate (coincident pylons) — nothing to span
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(g.midX, g.midY).setRotation(g.angle),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(g.length / 2, thickness / 2).setRestitution(0.4).setFriction(0),
      body,
    );
    this.wallBodies.set(id, body);
    this.wallColliders.set(id, collider);
    this.wallHandleToId.set(body.handle, 'wall-' + id);
  }

  /** Enable/disable a wall's collider (stun / power loss → pass-through). A
   *  no-op for an unknown id. */
  setWallActive(id: string, active: boolean): void {
    this.wallColliders.get(id)?.setEnabled(active);
  }

  /** Remove a wall span entirely (pylon destroyed / pair severed). */
  removeWall(id: string): void {
    const body = this.wallBodies.get(id);
    if (!body) return;
    this.wallHandleToId.delete(body.handle);
    this.world.removeRigidBody(body); // removes the body AND its collider
    this.wallBodies.delete(id);
    this.wallColliders.delete(id);
  }
}
