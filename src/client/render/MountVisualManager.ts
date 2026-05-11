/**
 * MountVisualManager — pooled per-mount turret + aim-line visuals.
 *
 * Multi-mount/turret refactor, Phase 3 (2026-05-11).
 *
 * For every ship with `mounts` in its ship-kind catalogue entry, this manager
 * builds a small Pixi `Graphics` cluster (one barrel sprite + one aim line per
 * mount) and parents it to the ship's main sprite, so the cluster inherits
 * the ship's world position and body rotation automatically. Each mount's
 * graphics live at `(mount.localX, mount.localY)` in ship-local space and are
 * rotated by `mount.baseAngle` (resting angle) so a fixed rear-facing mount
 * draws its barrel pointing backward without per-frame work.
 *
 * **Phase 3 scope (current)** — static mounts:
 *
 *   - `arcMin === arcMax === 0` and `rotationSpeed === 0` on every shipped
 *     mount. The barrel + aim-line rotate ONLY with the ship's body.
 *   - No arc indicator (a fixed mount's arc is a degenerate point).
 *   - Aim-line colour is constant.
 *
 * **Phase 4b will extend this** with:
 *
 *   - Per-tick rotation animation (read `mountAngles[mountIdx]` from the
 *     ship render state — to be added on `ShipRenderState`).
 *   - Aim arc indicator (faint wedge from `arcMin..arcMax`) on active-slot
 *     mounts only.
 *   - Aim-line colour modulation by `slotTarget` lock state.
 *
 * Pooled per ship: sprites are constructed once per (ship × mount) and live
 * until the ship is despawned. The hot per-frame path is a no-op for static
 * mounts because the ship sprite's own world transform already does the
 * heavy lifting.
 *
 * Legacy single-mount ships (fighter/scout/heavy) have one mount at the
 * ship's centre with zero base angle, so their mount visuals render
 * effectively underneath the ship body and are not visually intrusive.
 */

import { Container, Graphics } from 'pixi.js';
import { getShipKind, type ShipKind, type WeaponMount } from '../../shared-types/shipKinds';

/** Bookkeeping per ship — one cluster of mount graphics parented to the
 *  ship's sprite. The cluster `Container` rotates with the ship (because
 *  Pixi propagates the parent's `rotation` to its children), so each
 *  mount's draw-time transform is just its ship-local offset and base
 *  angle — no per-frame math required for static mounts. */
interface MountCluster {
  /** Parent of every per-mount Graphics for this ship. Lives as a child of
   *  the ship's sprite. */
  container: Container;
  /** mountId → graphics for that mount. */
  perMount: Map<string, MountGraphics>;
  /** Cached ship-kind id; if the ship's kind ever changes mid-life (it
   *  currently can't), we'd notice the mismatch and rebuild. */
  kindId: string | undefined;
}

interface MountGraphics {
  /** Small barrel sprite. */
  turret: Graphics;
  /** Faint preview line from barrel tip in the mount's current fire
   *  direction. Static for Phase 3; modulated by target lock in Phase 4b. */
  aimLine: Graphics;
}

/** Length (in world units) of the aim-line preview drawn from a mount's
 *  barrel tip. Short enough to not dominate the screen at typical zoom but
 *  long enough to make the mount's fire direction unambiguous. Phase 4b
 *  may scale this with the mount's weapon range. */
const AIM_LINE_LENGTH = 40;

/** Half-width of the barrel rectangle (mount sprite is `2 * BARREL_HALF_WIDTH`
 *  wide and `BARREL_LENGTH` long).
 *
 *  `BARREL_LENGTH` deliberately matches the 20 u server-side self-hit
 *  clearance offset used in `SectorRoom.handleFire` and the client's
 *  `updateLiveBeam` — so the beam emerges from the *visible* barrel tip
 *  rather than a point in space 12 u beyond it. Earlier the barrel was
 *  drawn 8 u long and beams emerged 20 u from the mount pivot, leaving a
 *  visible 12 u gap that user-test feedback flagged as "lasers don't
 *  come out of the exact tip of the barrel". */
const BARREL_HALF_WIDTH = 1.2;
const BARREL_LENGTH = 20;

export class MountVisualManager {
  private readonly clusters = new Map<string, MountCluster>();

  /**
   * Ensure a mount-visual cluster exists for the given ship and is parented
   * to `parent`. Returns the cluster's container so the caller can keep a
   * reference if it wants — though typically the caller just relies on the
   * fact that the parent owns the lifecycle.
   *
   * Idempotent: if a cluster already exists for `shipId`, this returns the
   * existing one without modification. Ship-kind changes are not supported
   * today; if `kindId` mismatches the cached one, the old cluster is torn
   * down and rebuilt.
   */
  ensureForShip(shipId: string, kindId: string | undefined, parent: Container | Graphics): Container {
    const existing = this.clusters.get(shipId);
    if (existing && existing.kindId === kindId) return existing.container;
    if (existing) {
      // Kind changed (theoretical). Destroy and rebuild from scratch.
      this.removeShip(shipId);
    }

    const kind = getShipKind(kindId ?? null);
    const container = new Container();
    parent.addChild(container);
    const perMount = new Map<string, MountGraphics>();

    if (kind.mounts && kind.mounts.length > 0) {
      for (const mount of kind.mounts) {
        const turret = buildTurretGfx(mount, kind);
        const aimLine = buildAimLineGfx(mount, kind);
        // Position in ship-local space. Pixi-up convention: ship-forward is
        // −y, so we flip Y when laying out the local offset.
        turret.x = mount.localX;
        turret.y = -mount.localY;
        turret.rotation = -mount.baseAngle;
        aimLine.x = mount.localX;
        aimLine.y = -mount.localY;
        aimLine.rotation = -mount.baseAngle;
        // Aim line draws first (beneath the turret sprite) so the barrel
        // visually appears to "cap" the line.
        container.addChild(aimLine);
        container.addChild(turret);
        perMount.set(mount.id, { turret, aimLine });
      }
    }

    this.clusters.set(shipId, { container, perMount, kindId });
    return container;
  }

  /** Remove a ship's mount cluster and free its graphics. Call from the
   *  same despawn path that destroys the ship sprite. */
  removeShip(shipId: string): void {
    const cluster = this.clusters.get(shipId);
    if (!cluster) return;
    cluster.container.destroy({ children: true });
    this.clusters.delete(shipId);
  }

  /** Mount count for a tracked ship — used by PixiRenderer to expose the
   *  `data-mount-count` test attribute. Returns 0 for ships not tracked. */
  mountCountForShip(shipId: string): number {
    return this.clusters.get(shipId)?.perMount.size ?? 0;
  }

  /** Tear down every cluster. Call from PixiRenderer.dispose. */
  disposeAll(): void {
    for (const cluster of this.clusters.values()) {
      cluster.container.destroy({ children: true });
    }
    this.clusters.clear();
  }
}

/**
 * Barrel sprite — a stubby rectangle extending forward (toward −y in
 * mount-local space). Coloured to match the ship's kind so the visual blends
 * coherently. A darker tip suggests "this end is the muzzle".
 */
function buildTurretGfx(_mount: WeaponMount, kind: ShipKind): Graphics {
  const g = new Graphics();
  // Body of the barrel (origin = mount pivot; barrel extends forward).
  g.rect(-BARREL_HALF_WIDTH, -BARREL_LENGTH, BARREL_HALF_WIDTH * 2, BARREL_LENGTH);
  g.fill({ color: kind.shape.color, alpha: 0.85 });
  // Dark muzzle tip — last 2 units.
  g.rect(-BARREL_HALF_WIDTH, -BARREL_LENGTH, BARREL_HALF_WIDTH * 2, 2);
  g.fill({ color: 0x000000, alpha: 0.55 });
  return g;
}

/**
 * Aim-line preview — a thin solid line from the barrel tip extending forward
 * by `AIM_LINE_LENGTH` world units. Faint by default so it doesn't dominate
 * the screen on a busy gameplay frame. Phase 4b modulates this line's
 * colour/alpha by whether the slot has an acquired target.
 */
function buildAimLineGfx(_mount: WeaponMount, kind: ShipKind): Graphics {
  const g = new Graphics();
  // From barrel tip (BARREL_LENGTH units forward of pivot) outward by
  // AIM_LINE_LENGTH along the mount's local forward axis.
  g.moveTo(0, -BARREL_LENGTH).lineTo(0, -(BARREL_LENGTH + AIM_LINE_LENGTH));
  g.stroke({ color: kind.shape.color, width: 1, alpha: 0.35 });
  return g;
}
