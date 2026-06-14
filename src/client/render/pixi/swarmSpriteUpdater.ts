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
import { wrapPi, rotateMountToward } from '../../../core/ai/WeaponMountController';
import {
  DAMAGE_FLASH_COLOR,
  buildShipGfxFromShape,
  shapeForKind,
  buildAsteroidGfx,
  buildDroneGfx,
  buildStructureGfx,
  buildScrapGfx,
  buildMinerRangeRingGfx,
  buildCapitalResourceText,
  formatResources,
} from './spriteBuilders.js';
import type { Text } from 'pixi.js';
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
  /** P3.8 — per-structure SLEWED mount (barrel/drill) arc-local angles, keyed by
   *  `swarm-<entityId>`, persisted across frames so the barrel rotates toward
   *  its target instead of SNAPPING. Owned + swept by the renderer (deleted with
   *  the sprite on despawn). */
  structureMountAngles: Map<string, number[]>;
  /** P3.8 — seconds since the previous call; the structure-mount slew rate input
   *  (`rotateMountToward` advances ≤ `rotationSpeed * slewDtSec` per call). The
   *  renderer computes it (clamped) from wall-clock; tests inject a fixed value
   *  for a deterministic slew. */
  slewDtSec: number;
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
  const slewDtSec = ctx.slewDtSec; // P3.8 — structure-mount slew rate input
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
        // WS-9 (R2.12) — the Capital shows its mineral bank as a world-space
        // number below the body. Built ONCE here (invariant #14).
        if (entry.shipKind === 'capital') sprite.addChild(buildCapitalResourceText(entry.radius));
      } else if (entry.kind === 3) {
        // Scrap (pose-core kind 3, scrap-on-death): one component of a dead
        // ship. Renders that component's recentred sub-shapes from the parent
        // ship-kind (entry.shipKind) + componentIndex, so the piece looks like
        // the part it broke off. Pose path below reads the resolved
        // single-per-frame pose (the drone kinematic-follower branch) so the
        // sprite matches the predWorld collision body (Phase-5 desync fix).
        sprite = buildScrapGfx(entry.shipKind, entry.componentIndex ?? 0);
      } else {
        sprite = buildAsteroidGfx(entityId, entry.radius);
      }
      ctx.shipContainer.addChild(sprite);
      ctx.sprites.set(spriteKey, sprite);
    }
    // Drones (kind 1) AND scrap (kind 3): read the already-resolved
    // single-per-frame pose that `ColyseusClient.updateMirror` wrote (the
    // kinematic-follower path — so the sprite matches the predWorld collision
    // body, one-pose-per-frame). Asteroids (0) + structures (2): render-now
    // interpolation off the poseRing (they are static server-side — see the
    // file docstring).
    const lerped = entry.kind === 1 || entry.kind === 3
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
        // P3.8 — persistent SLEWED arc-local angle per mount, created once + reused
        // (invariant #14). The barrel SLEWS toward its target via the shared
        // `rotateMountToward` instead of SNAPPING in one frame — the user's
        // "structures place at a weird angle then snap to the right position":
        // a blueprint turret/miner has no target so the barrel sits at base
        // (arc-local 0, "up"); the instant it acquired one it jumped to the
        // bearing. Now it eases over `rotationSpeed * dt`. No target ⇒ slew back
        // to base (0).
        let slew = ctx.structureMountAngles.get(spriteKey);
        if (!slew) {
          slew = [];
          for (let i = 0; i < structMounts.length; i++) slew.push(0);
          ctx.structureMountAngles.set(spriteKey, slew);
        }
        for (let i = 0; i < structMounts.length; i++) {
          const mount = structMounts[i]!;
          // Desired bearing in the mount's arc-local frame (canonical aim
          // convention forward = +y, right = +x ⇒ worldBearing = atan2(-dx, dy)),
          // or 0 (base) with no target. `rotateMountToward` clamps to the arc +
          // limits per-frame travel; `applyMountAngles` draws -(baseAngle+arc).
          let desiredArc = 0;
          if (targetEntry) {
            // Mount pivot in world space (structure mounts sit at the body
            // centre, localX=localY=0, but compute generally for correctness).
            const cosA = Math.cos(bodyAngle);
            const sinA = Math.sin(bodyAngle);
            const mountWorldX = bodyX + (mount.localX * cosA - mount.localY * sinA);
            const mountWorldY = bodyY + (mount.localX * sinA + mount.localY * cosA);
            const dx = targetEntry.x - mountWorldX;
            const dy = targetEntry.y - mountWorldY;
            const worldBearing = Math.atan2(-dx, dy);
            desiredArc = wrapPi(worldBearing - bodyAngle - mount.baseAngle);
          }
          const nextArc = rotateMountToward(slew[i] ?? 0, desiredArc, mount, slewDtSec);
          slew[i] = nextArc;
          _structureMountAngles.push(nextArc);
        }
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
      // WS-9 (R2.12) — update the Capital's mineral readout on CHANGE only (no
      // per-frame Text re-raster). Tagged child; capitals only, so the lookup is rare.
      if (entry.shipKind === 'capital') {
        const capText = sprite.getChildByLabel('capitalResource') as Text | null;
        if (capText) {
          const next = st?.minerals !== undefined ? formatResources(st.minerals) : '';
          if (capText.text !== next) capText.text = next;
        }
      }
    }
    // Sleeping entries stop interpolating; their pose is whatever the
    // server last shipped.
  }
}
