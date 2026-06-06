/**
 * Per-frame swarm-entity sprite update (asteroids + drones) — lifted
 * out of `PixiRenderer.update()`.
 *
 * Sprites are keyed by `swarm-${entityId}` so they can't collide with
 * playerIds in the shared `sprites` Map. Sleeping entries simply stop
 * receiving pose updates; the sprite stays parked at the last
 * server-shipped pose (no client-side dead reckoning).
 *
 * DRONES (kind=1) read the SINGLE per-frame display pose
 * `ColyseusClient.updateMirror` already resolved (one
 * `interpolateSwarmPose` per frame, written into `entry.x/y/angle` —
 * the same value the predWorld collision body, turret aim, and laser
 * beam use). Re-interpolating at render-`now` was a 2026-05-19 jitter
 * bug: the variable raf-jitter amplification made the sprite occupy
 * a different pose than the collision body/beam every frame.
 *
 * ASTEROIDS (kind=0) keep render-now interpolation off the poseRing —
 * they're locked/static server-side and `syncSwarmIntoPredWorld`
 * still poses their bodies from the raw decoded `entry.x/y`.
 *
 * Phase 4c — drones with rotating mounts get the same mount-cluster
 * treatment as player ships: turret sprites parented to the drone
 * body, rotated per-mount via `entry.mountAngles` from the slim
 * `snap.drones[]` slice. Legacy single-mount drone kinds have zero-
 * arc mounts so `applyMountAngles` is a no-op.
 */

import type { Container, Graphics } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { getShipKind } from '../../../shared-types/shipKinds';
import {
  DAMAGE_FLASH_COLOR,
  buildShipGfxFromShape,
  shapeForKind,
  buildAsteroidGfx,
  buildDroneGfx,
  buildStructureGfx,
} from './spriteBuilders.js';
import type { MountVisualManager } from '../MountVisualManager';
import {
  interpolateSwarmPose,
  type InterpolatedPose,
} from '../../net/swarmInterpolation';
import { resolveEntityDisplayPose } from '../../net/swarmDisplayPose';

export interface SwarmSpriteCtx {
  shipContainer: Container;
  sprites: Map<string, Graphics>;
  mountVisuals: MountVisualManager;
  swarmPoseScratch: InterpolatedPose;
  remoteHitTargets: Set<string>;
  localHitTargets: Set<string>;
  seenScratch: Set<string>;
}

export function updateSwarmSprites(mirror: RenderMirror, ctx: SwarmSpriteCtx): void {
  if (!mirror.swarm) return;
  const now = performance.now();
  for (const [entityId, entry] of mirror.swarm) {
    const spriteKey = `swarm-${entityId}`;
    ctx.seenScratch.add(spriteKey);
    let sprite = ctx.sprites.get(spriteKey);
    if (!sprite) {
      if (entry.kind === 1) {
        // Drones use the same procedural shape as player ships of that
        // kind, so a Heavy drone visibly reads as a Heavy. Falls back
        // to the legacy magenta dart silhouette when the wire didn't
        // carry a kind (older snapshots / pre-v2 packets).
        sprite = entry.shipKind
          ? buildShipGfxFromShape(shapeForKind(entry.shipKind))
          : buildDroneGfx(entry.radius);
      } else if (entry.kind === 2) {
        // Structures (pose-core kind 2): a per-subtype tinted polygon read from
        // the shared shipKind byte (structures plan, Phase 2).
        sprite = buildStructureGfx(entry.shipKind, entry.radius);
      } else {
        sprite = buildAsteroidGfx(entityId, entry.radius);
      }
      ctx.shipContainer.addChild(sprite);
      ctx.sprites.set(spriteKey, sprite);
    }
    // Drones: read the already-resolved single-per-frame pose; asteroids:
    // render-now interpolation (see file docstring).
    const lerped = entry.kind === 1
      ? resolveEntityDisplayPose(entry, ctx.swarmPoseScratch)
      : interpolateSwarmPose(entry, now, ctx.swarmPoseScratch);
    sprite.x = lerped.x;
    sprite.y = -lerped.y;
    sprite.rotation = -lerped.angle;
    if (entry.kind === 1 && entry.shipKind) {
      ctx.mountVisuals.ensureForShip(spriteKey, entry.shipKind, sprite);
      const swarmKind = getShipKind(entry.shipKind);
      const swarmMounts = swarmKind.mounts ?? [];
      if (swarmMounts.length > 0) {
        ctx.mountVisuals.applyMountAngles(spriteKey, swarmMounts, entry.mountAngles);
      }
    }
    // Damage flash + beam-hit tint (both render as the damage colour so
    // a drone clearly registers a hit even when no beam is currently on it).
    if (
      mirror.damagedShips?.has(spriteKey) ||
      ctx.localHitTargets.has(spriteKey) ||
      ctx.remoteHitTargets.has(spriteKey)
    ) {
      sprite.tint = DAMAGE_FLASH_COLOR;
    } else {
      sprite.tint = 0xffffff;
    }
    // Structures plan, Phase 3 — blueprints (not yet built) render dimmed
    // ("scaffolding"); the fill-bar (ConnectorRenderer) shows build progress.
    if (entry.kind === 2) {
      const st = mirror.structures?.get(entityId);
      sprite.alpha = st && !st.built ? 0.45 : 1;
    }
    // Sleeping entries stop interpolating; their pose is whatever the
    // server last shipped.
  }
}
