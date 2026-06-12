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
import { getShipKind, type WeaponMount } from '../../../shared-types/shipKinds';
import { getStructureKind } from '../../../shared-types/structureKinds';
import { clampToArc, wrapPi } from '../../../core/ai/WeaponMountController';
import {
  DAMAGE_FLASH_COLOR,
  buildShipGfxFromShape,
  shapeForKind,
  buildAsteroidGfx,
  buildDroneGfx,
  buildStructureGfx,
  buildMinerRangeRingGfx,
} from './spriteBuilders.js';
import { minerRangeForKind } from '../minerRangeRing.js';
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

/** Module-scope scratch for a structure's per-mount arc-local angles passed
 *  into `applyMountAngles`. Structures carry exactly ONE mount today (the
 *  turret 'barrel' / the miner 'drill'), but the array is shaped to the
 *  catalogue mount list and CLEARED per structure (`.length = 0` then push)
 *  so a prior structure's angle can never contaminate the next (invariant
 *  #14 — no per-frame allocation; reused in place). */
const _structureMountAngles: number[] = [];

/** Shared frozen empty mount-list. `?? EMPTY_MOUNTS` is the fallback for a
 *  kind with no mounts (capital / connector / solar structures, mountless
 *  drone kinds) — it avoids allocating a fresh `[]` literal every frame in
 *  this render-loop hot path (invariant #14). */
const EMPTY_MOUNTS: readonly WeaponMount[] = [];

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
        // WS-4 Phase 5 (R2.16) — a Miner shows a faint dashed mining-range ring
        // at its `miningRange` radius. Built HERE (the once-per-sprite create
        // path, invariant #14 — never per-frame) and parented to the body so it
        // tracks the structure. Only the Miner has a miningRange; others skip.
        const miningRange = minerRangeForKind(entry.shipKind);
        if (miningRange) sprite.addChild(buildMinerRangeRingGfx(miningRange));
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
      const swarmMounts = swarmKind.mounts ?? EMPTY_MOUNTS;
      if (swarmMounts.length > 0) {
        ctx.mountVisuals.applyMountAngles(spriteKey, swarmMounts, entry.mountAngles);
      }
    } else if (entry.kind === 2) {
      // Structures (turret 'barrel' / miner 'drill') carry a mounts entry in
      // the catalogue but NO mountAngles on any wire — the snapshot
      // `structures[]` slice ships only turretTargetId / miningTargetId. So
      // the barrel angle is DERIVED here from the target id + that target
      // entity's resolved pose, and aimed via the SAME pure controller +
      // Y-flip the player/drone mounts use (Invariant #12 consistency).
      const sk = getStructureKind(entry.shipKind);
      const structMounts = sk.mounts ?? EMPTY_MOUNTS;
      ctx.mountVisuals.ensureForMounts(spriteKey, sk.id, structMounts, sk.color, sprite);
      if (structMounts.length > 0) {
        const st = mirror.structures?.get(entityId);
        const targetId = st?.turretTargetId ?? st?.miningTargetId;
        const targetEntry = targetId !== undefined ? mirror.swarm.get(targetId) : undefined;
        _structureMountAngles.length = 0;
        // Body pose = the resolved sprite pose (game-space, from `lerped`).
        const bodyX = lerped.x;
        const bodyY = lerped.y;
        const bodyAngle = lerped.angle;
        for (let i = 0; i < structMounts.length; i++) {
          const mount = structMounts[i]!;
          let arcLocal = 0;
          if (targetEntry) {
            // Mount pivot in world space (structure mounts sit at the body
            // centre, localX=localY=0, but compute generally for correctness).
            const cosA = Math.cos(bodyAngle);
            const sinA = Math.sin(bodyAngle);
            const mountWorldX = bodyX + (mount.localX * cosA - mount.localY * sinA);
            const mountWorldY = bodyY + (mount.localX * sinA + mount.localY * cosA);
            const dx = targetEntry.x - mountWorldX;
            const dy = targetEntry.y - mountWorldY;
            // Canonical aim convention (WeaponMountTicker / localMountAim):
            // forward = +y, right = +x ⇒ worldBearing = atan2(-dx, dy); then
            // rotate into the mount's arc-local frame and clamp to the arc.
            const worldBearing = Math.atan2(-dx, dy);
            // NOTE: structures carry no per-tick mount-angle state client-side,
            // so this SNAPS the barrel to the clamped target each frame rather
            // than slewing via `rotateMountToward` like the player/drone path.
            // Fine for a stateless visual; revisit if a structure mount ever
            // gains a tight arc + rotationSpeed (the snap would read instant).
            arcLocal = clampToArc(wrapPi(worldBearing - bodyAngle - mount.baseAngle), mount);
          }
          _structureMountAngles.push(arcLocal);
        }
        // applyMountAngles applies spriteRotation = -(mount.baseAngle + current),
        // exactly matching the player/drone path — so the barrel points AT the
        // target (a sign error here would point it 180° away).
        ctx.mountVisuals.applyMountAngles(spriteKey, structMounts, _structureMountAngles);
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
