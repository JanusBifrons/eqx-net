/**
 * Per-frame active-ship sprite update — lifted out of
 * `PixiRenderer.update()`.
 *
 * One pass over `mirror.ships`:
 *   - Lazy-construct the sprite from the catalogue's polygon + colour
 *     (local-vs-remote is communicated by camera-follow, not colour).
 *   - Attach mount visuals (turret sprites + aim lines) per the ship
 *     catalogue. `ensureForShip` is idempotent — re-uses the existing
 *     cluster while `ship.kind` is unchanged.
 *   - Apply per-mount rotation angles. Local player's
 *     `tickLocalMountAim` populates `mirror.ships.get(localId)
 *     .mountAngles`; remotes get the server's authoritative angles
 *     via the snapshot.
 *   - Write pose + tint (damage flash > beam hit > normal).
 *   - Lazy-create + animate the thrust + boost flames as children of
 *     the ship sprite (inherits rotation). The flames stay attached
 *     after first use; toggling thrust/boost flips `.visible` rather
 *     than churning the scene graph.
 *
 * Pixi convention: world Y is flipped (`sprite.y = -ship.y`) and
 * rotation is negated.
 */

import type { Container, Graphics } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { getShipKind } from '../../../shared-types/shipKinds';
import {
  DAMAGE_FLASH_COLOR,
  buildShipGfxFromShape,
  shapeForKind,
  buildThrustFlameGfx,
  buildBoostFlameGfx,
} from './spriteBuilders.js';
import type { MountVisualManager } from '../MountVisualManager';

export interface ShipSpriteCtx {
  shipContainer: Container;
  sprites: Map<string, Graphics>;
  thrustFlames: Map<string, Graphics>;
  boostFlames: Map<string, Graphics>;
  mountVisuals: MountVisualManager;
  /** Filled by the caller from this frame's mirror; passed in to avoid
   *  recomputing per ship. */
  remoteHitTargets: Set<string>;
  localHitTargets: Set<string>;
  /** Persistent scratch — caller adds each visited playerId so the
   *  caller can drop sprites for ships absent from `mirror.ships`. */
  seenScratch: Set<string>;
}

export function updateShipSprites(mirror: RenderMirror, ctx: ShipSpriteCtx): void {
  for (const [playerId, ship] of mirror.ships) {
    ctx.seenScratch.add(playerId);

    let sprite = ctx.sprites.get(playerId);
    if (!sprite) {
      sprite = buildShipGfxFromShape(shapeForKind(ship.kind));
      ctx.shipContainer.addChild(sprite);
      ctx.sprites.set(playerId, sprite);
    }
    ctx.mountVisuals.ensureForShip(playerId, ship.kind, sprite);
    const shipKind = getShipKind(ship.kind ?? null);
    const shipMounts = shipKind.mounts ?? [];
    if (shipMounts.length > 0) {
      ctx.mountVisuals.applyMountAngles(playerId, shipMounts, ship.mountAngles);
    }

    sprite.x = ship.x;
    sprite.y = -ship.y;
    sprite.rotation = -ship.angle;

    // Damage flash takes priority; beam hit tint is secondary.
    if (mirror.damagedShips?.has(playerId)) {
      sprite.tint = DAMAGE_FLASH_COLOR;
    } else if (ctx.localHitTargets.has(playerId) || ctx.remoteHitTargets.has(playerId)) {
      sprite.tint = 0xff2222;
    } else {
      sprite.tint = 0xffffff;
    }

    // Thrust flame (baseline, any acceleration). Child of the ship
    // sprite so it inherits rotation; lazy-created on first thrust.
    // Added BEFORE the boost flame so the boost plume layers on top.
    const isThrusting = mirror.thrustingShips?.has(playerId) ?? false;
    let thrustFlame = ctx.thrustFlames.get(playerId);
    if (isThrusting) {
      if (!thrustFlame) {
        thrustFlame = buildThrustFlameGfx();
        sprite.addChild(thrustFlame);
        ctx.thrustFlames.set(playerId, thrustFlame);
      }
      thrustFlame.visible = true;
      // Per-frame flicker so the plume reads as fire, not a static arrow.
      thrustFlame.scale.y = 0.85 + Math.random() * 0.4;
      thrustFlame.alpha = 0.75 + Math.random() * 0.25;
    } else if (thrustFlame) {
      thrustFlame.visible = false;
    }

    // Boost flame — layered ON TOP of thrust when both are active.
    // Lazily created on first boost; left as a hidden child after-
    // wards so toggling shift doesn't churn the scene graph.
    const isBoosting = mirror.boostingShips?.has(playerId) ?? false;
    let flame = ctx.boostFlames.get(playerId);
    if (isBoosting) {
      if (!flame) {
        flame = buildBoostFlameGfx();
        sprite.addChild(flame);
        ctx.boostFlames.set(playerId, flame);
      }
      flame.visible = true;
      flame.scale.y = 0.9 + Math.random() * 0.5;
      flame.alpha = 0.8 + Math.random() * 0.2;
    } else if (flame) {
      flame.visible = false;
    }
  }
}
