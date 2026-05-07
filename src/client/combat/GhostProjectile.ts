import { HITSCAN_RANGE } from '@core/combat/Weapons';
import { getWeapon, isWeaponId } from '@core/combat/WeaponCatalogue';
import type { ProjectileRenderState } from '@core/contracts/IRenderer';

const BEAM_TTL_MS = 250;
const PROJECTILE_GHOST_TTL_MS = 500;

interface GhostEntry {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ownerId: string;
  spawnedAt: number;
  ttlMs: number;
  resolved: boolean;
  beam?: { toX: number; toY: number };
  weaponId?: string;
}

/**
 * Manages client-side ghost projectiles — Pixi-only sprite trails spawned
 * immediately on fire input to hide network latency.
 *
 * Ghosts are presentation only and never influence authoritative state.
 * They are resolved (faded) when hit_ack arrives or after TTL expires.
 */
export class GhostManager {
  private readonly ghosts = new Map<string, GhostEntry>();

  /** Spawn a ghost on the same frame the FIRE message is sent. */
  spawn(
    clientShotId: string,
    ownerId: string,
    fromX: number,
    fromY: number,
    dirX: number,
    dirY: number,
    weapon: string,
    shooterVx: number = 0,
    shooterVy: number = 0,
  ): void {
    const len = Math.hypot(dirX, dirY);
    if (len < 0.001) return;
    const nx = dirX / len;
    const ny = dirY / len;

    const weaponDef = isWeaponId(weapon) ? getWeapon(weapon) : null;

    if (!weaponDef || weaponDef.mode === 'hitscan') {
      this.ghosts.set(clientShotId, {
        id: clientShotId,
        x: fromX,
        y: fromY,
        vx: 0,
        vy: 0,
        ownerId,
        spawnedAt: performance.now(),
        ttlMs: BEAM_TTL_MS,
        resolved: false,
        beam: { toX: fromX + nx * HITSCAN_RANGE, toY: fromY + ny * HITSCAN_RANGE },
        weaponId: weapon,
      });
    } else {
      const speed = weaponDef.mode === 'projectile' ? weaponDef.speed : 300;
      this.ghosts.set(clientShotId, {
        id: clientShotId,
        x: fromX,
        y: fromY,
        vx: shooterVx + nx * speed,
        vy: shooterVy + ny * speed,
        ownerId,
        spawnedAt: performance.now(),
        ttlMs: PROJECTILE_GHOST_TTL_MS,
        resolved: false,
        weaponId: weapon,
      });
    }
  }

  /** Called when hit_ack arrives. */
  resolve(clientShotId: string, hit: boolean): void {
    const ghost = this.ghosts.get(clientShotId);
    if (!ghost) return;
    ghost.resolved = true;
    void hit;
  }

  /**
   * Called every render frame. Advances ghost positions and writes to the
   * provided map for the renderer to consume. Expired ghosts are removed.
   */
  update(dtMs: number, out: Map<string, ProjectileRenderState>): void {
    const dtSec = dtMs / 1000;
    const now = performance.now();

    for (const [id, ghost] of this.ghosts) {
      const ageMs = now - ghost.spawnedAt;

      if (ghost.resolved || ageMs > ghost.ttlMs) {
        this.ghosts.delete(id);
        out.delete(id);
        continue;
      }

      ghost.x += ghost.vx * dtSec;
      ghost.y += ghost.vy * dtSec;

      out.set(id, {
        x: ghost.x,
        y: ghost.y,
        vx: ghost.vx,
        vy: ghost.vy,
        ownerId: ghost.ownerId,
        isGhost: true,
        beam: ghost.beam,
        weaponId: ghost.weaponId,
      });
    }
  }

  /** Evict all unresolved ghosts for a ship that just died. */
  clearForShip(ownerId: string): void {
    for (const [id, ghost] of this.ghosts) {
      if (ghost.ownerId === ownerId) this.ghosts.delete(id);
    }
  }

  get pendingCount(): number {
    return this.ghosts.size;
  }
}
