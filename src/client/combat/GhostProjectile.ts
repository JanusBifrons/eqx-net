import { HITSCAN_RANGE } from '@core/combat/Weapons';
import { getWeapon, isWeaponId } from '@core/combat/WeaponCatalogue';
import type { ProjectileRenderState } from '@core/contracts/IRenderer';

const BEAM_TTL_MS = 250;
const PROJECTILE_GHOST_TTL_MS = 500;

interface GhostEntry {
  /** Map key — unique per ghost. For multi-mount ships this is
   *  `${clientShotId}:${mountId}`; for legacy single-mount ships this is the
   *  bare `clientShotId` (back-compat with pre-2c spawn callers). */
  id: string;
  /** The wire-level FireMessage `clientShotId` this ghost belongs to. All
   *  N ghosts spawned for one fire share the same `shotGroup`, so a single
   *  `resolve(clientShotId)` fades the whole salvo on hit_ack arrival. */
  shotGroup: string;
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

  /** Spawn a ghost on the same frame the FIRE message is sent.
   *
   *  Multi-mount/turret refactor (Phase 3 fix-up): an optional `mountId`
   *  param disambiguates ghosts from the same fire request when a ship has
   *  multiple mounts in its active slot. Pre-2c callers pass no `mountId`
   *  and the ghost is keyed by `clientShotId` directly (unchanged behaviour).
   *  When passed, the ghost is keyed by `${clientShotId}:${mountId}` so
   *  multiple ghosts can coexist for one wire fire, and `resolve` fades
   *  every ghost in the group on a single `hit_ack`. */
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
    mountId?: string,
  ): void {
    const len = Math.hypot(dirX, dirY);
    if (len < 0.001) return;
    const nx = dirX / len;
    const ny = dirY / len;

    const weaponDef = isWeaponId(weapon) ? getWeapon(weapon) : null;
    const id = mountId ? `${clientShotId}:${mountId}` : clientShotId;

    if (!weaponDef || weaponDef.mode === 'hitscan') {
      this.ghosts.set(id, {
        id,
        shotGroup: clientShotId,
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
      this.ghosts.set(id, {
        id,
        shotGroup: clientShotId,
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

  /** Called when hit_ack arrives. Fades every ghost that was spawned for
   *  the given `clientShotId`, even when the salvo wrote N entries under
   *  per-mount keys (multi-mount/turret refactor). Single-mount fires
   *  still fade exactly the one ghost they spawned. */
  resolve(clientShotId: string, hit: boolean): void {
    for (const ghost of this.ghosts.values()) {
      if (ghost.shotGroup === clientShotId) {
        ghost.resolved = true;
      }
    }
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

      // Mutate the existing render-state entry if present; allocate a
      // fresh one only on first sight. Pre-pool the lazy-mochi handoff
      // (line 204) flagged this `out.set(id, {...})` per-frame literal
      // as a top non-FX allocator under held-fire; with ~5-15 ghosts
      // active at steady state × 60 RAF/s, the old path produced
      // 300-900 fresh ProjectileRenderState literals per second.
      let entry = out.get(id);
      if (!entry) {
        entry = {
          x: ghost.x,
          y: ghost.y,
          vx: ghost.vx,
          vy: ghost.vy,
          ownerId: ghost.ownerId,
          isGhost: true,
          ...(ghost.beam !== undefined ? { beam: ghost.beam } : {}),
          ...(ghost.weaponId !== undefined ? { weaponId: ghost.weaponId } : {}),
        };
        out.set(id, entry);
      } else {
        entry.x = ghost.x;
        entry.y = ghost.y;
        entry.vx = ghost.vx;
        entry.vy = ghost.vy;
        entry.ownerId = ghost.ownerId;
        entry.isGhost = true;
        // `ghost.beam` and `ghost.weaponId` are stamped on spawn and
        // never mutate during the ghost's lifetime — reuse the same
        // refs. The `delete` arms cover the case where a later spawn
        // for the same id (key reuse impossible per `${shotId}:${mountId}`,
        // but defensive) flips the optional fields off.
        if (ghost.beam !== undefined) entry.beam = ghost.beam;
        else delete entry.beam;
        if (ghost.weaponId !== undefined) entry.weaponId = ghost.weaponId;
        else delete entry.weaponId;
      }
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

  /**
   * Plan: crispy-kazoo, Commit 6 — full teardown.
   * Drops every pending ghost. Idempotent; safe to call after dispose
   * (the ghosts Map is just emptied on the second call).
   */
  dispose(): void {
    this.ghosts.clear();
  }
}
