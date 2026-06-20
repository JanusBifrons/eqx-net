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
 *
 * Engine exhaust is NOT drawn here — the particle-only `EngineEmitter`
 * (effects subsystem) is the sole engine visual; the legacy triangle flame
 * children were removed by the engine-fx pass (plan `majestic-pie`).
 *
 * Pixi convention: world Y is flipped (`sprite.y = -ship.y`) and
 * rotation is negated.
 */

import type { Container, Graphics } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { getShipKind } from '../../../shared-types/shipKinds';
import { resolveInstanceMounts } from '../../../shared-types/shipKinds/slots';
import { shipPrimaryColor } from '@core/geometry/shipHullOutline';
import {
  DAMAGE_FLASH_COLOR,
  buildShipGfxFromShape,
  shapeForKind,
} from './spriteBuilders.js';
import type { MountVisualManager } from '../MountVisualManager';

export interface ShipSpriteCtx {
  shipContainer: Container;
  sprites: Map<string, Graphics>;
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
    const shipKind = getShipKind(ship.kind ?? null);
    // WS-B3 — the per-instance mount list `[...kind.mounts, ...activated]`. When
    // the ship has ACTIVATED latent mounts the cluster is built for the full
    // list (extra turrets drawn) and rebuilt when the set changes (`mountSig`).
    // Un-upgraded ⇒ the kind-only `ensureForShip` path (alloc-free, byte-
    // identical to pre-WS-B3 — `resolveInstanceMounts` returns the base ref).
    const activated = ship.activatedMounts;
    let shipMounts;
    if (activated && activated.length > 0) {
      shipMounts = resolveInstanceMounts(shipKind, activated);
      // Signature = the activated slot ids (the base mounts never change for a
      // kind). Only computed on the rare activated path, so the per-frame
      // un-upgraded path stays alloc-free (invariant #14).
      let sig = '';
      for (const a of activated) sig += a.slotId + '|' + a.weaponId + ';';
      ctx.mountVisuals.ensureForInstance(playerId, ship.kind, shipMounts, shipPrimaryColor(shipKind), sig, sprite);
    } else {
      ctx.mountVisuals.ensureForShip(playerId, ship.kind, sprite);
      shipMounts = shipKind.mounts ?? [];
    }
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

    // Engine exhaust is no longer a triangle flame child here — the
    // particle-only `EngineEmitter` (driven off mirror.thrustingShips /
    // boostingShips by `PixiRenderer.syncEngineContinuousEffects`) is the
    // sole engine visual.
  }
}
