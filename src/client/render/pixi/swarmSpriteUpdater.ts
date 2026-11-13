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

import { npcFactionDef } from '../../../shared-types/factions.js';
import { isSpriteInView } from '../spriteUpdateDecisions.js';
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
  buildBatteryChargeText,
  buildBuildEtaText,
  formatResources,
  formatBuildEta,
  buildChargeTelegraphGfx,
  buildEliteRingGfx,
} from './spriteBuilders.js';
import type { Text } from 'pixi.js';
import { getWeapon } from '../../../core/combat/WeaponCatalogue';
import { minerRangeForKind } from '../minerRangeRing.js';
import type { MountVisualManager } from '../MountVisualManager';
import {
  buildArtShipSprite, isMachinedSprite, rockHandleFor, scrapHandleFor, shipArtSwap, shipHandleFor, structHandleFor,
  updateArtShipLight, type ShipArtCtx,
} from '../art/shipArtSprites.js';
import { MachinedShipSprite } from '../art/MachinedShipSprite.js';
import {
  interpolateSwarmPose,
  type InterpolatedPose,
} from '../../net/swarmInterpolation';
import { resolveEntityDisplayPose } from '../../net/swarmDisplayPose';
import type { WreckGeometryStore } from '../../net/wreckGeometryStore';
import { WreckPieceSprite, coolWreckInfo, type WreckArtState } from './wreckArt.js';
import type { DyingHullHold } from './dyingHullHold.js';

/** S2b: an empty wreck map for frames whose mirror carries none. */
const NO_WRECKS: ReadonlyMap<number, unknown> = new Map();

/** Campaign 3.2 — everything (besides the pose-core kind, tracked separately
 *  in `spriteKinds` for #20 back-compat) that a swarm sprite's VISUAL is built
 *  from. Any component changing under a recycled entityId means the cached
 *  sprite is the wrong picture. */
export interface SpriteBuildSig {
  shipKind: string | null;
  componentIndex: number;
  radius: number;
  /** S2b: a wreck piece's wreck (0 for every other kind). */
  wreckId: number;
}

export interface SwarmSpriteCtx {
  /** A3 — the camera's visible rect (pixi space) this frame; structures
   *  outside it are not drawn. Absent ⇒ draw everything. */
  viewBounds?: Float64Array;
  shipContainer: Container;
  sprites: Map<string, Container>;
  /** Machined art (A3): drones of a known ship kind; null service ⇒ today's look. */
  art: ShipArtCtx;
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
  /** Equinox Phase 3 #20 — parallel to `sprites`: the `kind` each cached sprite
   *  was BUILT for, keyed by `swarm-<entityId>`. The server recycles the dense
   *  u16 entityId (a destroyed structure's id is handed to the next spawn), so a
   *  cached entityId's `kind` byte can FLIP (structure 2 → drone 1). The reaper
   *  sweep only despawns entities ABSENT from the frame (a recycled id stays
   *  present), so without this the stale structure sprite is reused for the new
   *  drone — the "drone renders as a connector/turret" bug. On a kind change the
   *  updater tears the sprite down + rebuilds. Owned + swept by the renderer
   *  (deleted with the sprite on despawn), like `structureMountAngles`. */
  spriteKinds: Map<string, number>;
  /** Campaign 3.2 (review B4) — the FULL build signature each cached sprite
   *  was constructed from. #20's `spriteKinds` guard catches a pose-core kind
   *  flip, but the sprite is BUILT from `(kind, shipKind, componentIndex,
   *  radius)`: a recycled id keeping the same kind while changing SUBTYPE
   *  (connector→turret, fighter→heavy, another scrap component) kept the
   *  stale silhouette. Record allocated ONCE on the create path (#14 — the
   *  per-frame check is a map get + scalar compares); deleted with the
   *  sprite (guard teardown + renderer reaper sweep). */
  spriteBuildSigs: Map<string, SpriteBuildSig>;
  /** P3.8 — seconds since the previous call; the structure-mount slew rate input
   *  (`rotateMountToward` advances ≤ `rotationSpeed * slewDtSec` per call). The
   *  renderer computes it (clamped) from wall-clock; tests inject a fixed value
   *  for a deterministic slew. */
  slewDtSec: number;
  /** Capital destruction S2b: the renderer's wreck geometry, rebuilt from
   *  `mirror.wrecks` (the worker has its own heap). Absent ⇒ wreck pieces are
   *  not drawn. */
  wrecks?: WreckGeometryStore;
  /** Capital destruction S3: per-wreck death clock + break-up sink. Absent ⇒
   *  pieces draw cool and no break-up plays. */
  wreckArt?: WreckArtState;
  /** The renderer's presentation clock (fxNow, ms), which follows the game
   *  speed: wreck death clocks and the cut-edge glow age on it, so they slow
   *  down in slow motion and speed up at 4x. Absent: the wall `now` (tests).
   *  Pose interpolation stays on the wall clock (wall-stamped arrivals). */
  fxNowMs?: number;
  /** Dying capitals held on screen until their wreck pieces are drawn; told
   *  of every piece drawn this frame. Absent ⇒ no hold. */
  dyingHulls?: DyingHullHold;
}

/** Module-scope scratch for a structure's per-mount arc-local angles passed
 *  into `applyMountAngles`. Structures carry exactly ONE mount today (the
 *  turret 'barrel' / the miner 'drill'), but the array is shaped to the
 *  catalogue mount list and CLEARED per structure (`.length = 0` then push)
 *  so a prior structure's angle can never contaminate the next (invariant
 *  #14 — no per-frame allocation; reused in place). */
const _structureMountAngles: number[] = [];
/** A defence structure's drawn barrel eases toward the server's angle this
 *  much faster than its traverse, so it catches up within a turret tick. */
const SERVER_AIM_CATCH_UP = 1.5;

/** Shared frozen empty mount-list. `?? EMPTY_MOUNTS` is the fallback for a
 *  kind with no mounts (capital / connector / solar structures, mountless
 *  drone kinds) — it avoids allocating a fresh `[]` literal every frame in
 *  this render-loop hot path (invariant #14). */
const EMPTY_MOUNTS: readonly WeaponMount[] = [];

/** P3c — drone sprite → its charge telegraph child (weak: dies with the sprite). */
const chargeTelegraphs = new WeakMap<Container, Graphics>();
/** P4a — a named elite's gold ring, created lazily the first frame the sprite
 *  is known to be an elite (once per sprite, #14), then shown/hidden. */
const eliteRings = new WeakMap<Container, Graphics>();

/** A6 — fresh wreckage glows hot and cools to its own colour over this long. */
export const SCRAP_COOL_MS = 5000;
/** When each scrap sprite was first drawn (dies with the sprite). */
const scrapBorn = new WeakMap<Container, number>();
/** The heat tint of wreckage `ageMs` after it broke off: hot orange easing to
 *  none (undefined = cool). Pure; allocation-free. */
export function scrapHeatTint(ageMs: number): number | undefined {
  if (!(ageMs >= 0) || ageMs >= SCRAP_COOL_MS) return undefined;
  const h = 1 - ageMs / SCRAP_COOL_MS, k = h * h;
  const g = Math.round(255 - (255 - 0x7a) * k), b = Math.round(255 - (255 - 0x30) * k);
  return (0xff << 16) | (g << 8) | b;
}

/** The longest charge weapon range a kind carries (0 ⇒ no charge weapon). */
export function chargeRangeForKind(shipKind: string | undefined): number {
  if (!shipKind) return 0;
  let r = 0;
  for (const m of getShipKind(shipKind).mounts ?? EMPTY_MOUNTS) {
    const w = getWeapon(m.weaponId);
    if (w.mode === 'hitscan' && (w.chargeTicks ?? 0) > 0 && w.range > r) r = w.range;
  }
  return r;
}


/** Classic-look rocks: ice and crystal-veined ones read apart from plain rock
 *  (a Machined rock bakes its resource colour instead). W3: this used to be
 *  set once at build, and the reset below wiped it every frame. */
function classicRockTint(resource: string | undefined): number | undefined {
  return resource === 'ice' ? 0xa8dcff : resource === 'crystal' ? 0xd2a8ff : undefined;
}

export function updateSwarmSprites(mirror: RenderMirror, ctx: SwarmSpriteCtx): void {
  if (!mirror.swarm) return;
  const now = performance.now();
  const fxNow = ctx.fxNowMs ?? now; // game-speed presentation clock (wreck glow / death clock)
  const slewDtSec = ctx.slewDtSec; // P3.8 — structure-mount slew rate input
  const wreckDescs = mirror.wrecks;
  ctx.wrecks?.retain(wreckDescs ?? NO_WRECKS);
  ctx.wreckArt?.retain(wreckDescs ?? NO_WRECKS);
  for (const [entityId, entry] of mirror.swarm) {
    // S2b: a wreck piece is drawn only once its wreck's descriptor is known
    // (its geometry comes from it); until then it has no sprite at all.
    if (entry.kind === 4 && (entry.wreckId === undefined || wreckDescs === undefined || !wreckDescs.has(entry.wreckId) || ctx.wrecks === undefined)) continue;
    const spriteKey = `swarm-${entityId}`;
    ctx.seenScratch.add(spriteKey);
    let sprite = ctx.sprites.get(spriteKey);
    // Equinox Phase 3 #20 — a recycled entityId can flip kind (a destroyed
    // structure's slot reused by a new drone). The sprite is cached by entityId;
    // if the kind changed since it was built, the cached visual is the WRONG
    // type — tear it down (sprite + barrel cluster + slew state) so the create
    // path below rebuilds it. Without this the drone renders as the connector/
    // turret it recycled.
    // Campaign 3.2 (review B4) — the rebuild guard compares the FULL build
    // signature, not just the pose-core kind: a recycled id that stays the
    // same kind but flips SUBTYPE (connector→turret, fighter→heavy, another
    // scrap componentIndex) or radius is equally the wrong picture.
    const sig = ctx.spriteBuildSigs.get(spriteKey);
    if (
      sprite &&
      (ctx.spriteKinds.get(spriteKey) !== entry.kind ||
        sig === undefined ||
        sig.shipKind !== (entry.shipKind ?? null) ||
        sig.componentIndex !== (entry.componentIndex ?? 0) ||
        sig.radius !== entry.radius ||
        sig.wreckId !== (entry.wreckId ?? 0))
    ) {
      ctx.shipContainer.removeChild(sprite);
      ctx.mountVisuals.removeShip(spriteKey);
      ctx.structureMountAngles.delete(spriteKey);
      ctx.spriteBuildSigs.delete(spriteKey);
      sprite.destroy({ children: true });
      ctx.sprites.delete(spriteKey);
      sprite = undefined;
    }
    // Machined art: each kind swaps to its Machined sprite once the art is
    // ready (A3 drones, A4 structures / scrap / asteroids). A patrol bakes in
    // its faction's paint (tinting a lit sprite would muddy it); structures
    // and asteroids bake their turn so the sun stays put.
    const artHandle = !ctx.art.art
      ? null
      : entry.kind === 1 && entry.shipKind
        ? shipHandleFor(ctx.art, spriteKey, entry.shipKind, entry.faction !== undefined ? npcFactionDef(entry.faction)?.color : undefined)
        : entry.kind === 2 && entry.shipKind
          ? structHandleFor(ctx.art, spriteKey, entry.shipKind, -entry.angle)
          : entry.kind === 3 && entry.shipKind
            ? scrapHandleFor(ctx.art, spriteKey, entry.shipKind, entry.componentIndex ?? 0)
            : entry.kind === 0
              ? rockHandleFor(ctx.art, spriteKey, entityId, entry.radius, entry.asteroidResource, -entry.angle)
              : null;
    // S3: a wreck piece draws its PARENT kind's own baked art (the handle the
    // live hull used, so no re-bake). Swap the plain piece once it is ready.
    const wreckArtHandle = entry.kind === 4 && ctx.art.art
      ? shipHandleFor(ctx.art, spriteKey, entry.shipKind ?? wreckDescs!.get(entry.wreckId!)!.parentKind, undefined)
      : null;
    if (
      sprite instanceof WreckPieceSprite && wreckArtHandle !== null &&
      wreckArtHandle.state === 'ready' && wreckArtHandle.ship !== null && sprite.art !== wreckArtHandle.ship
    ) {
      ctx.shipContainer.removeChild(sprite);
      ctx.spriteBuildSigs.delete(spriteKey);
      sprite.destroy({ children: true });
      ctx.sprites.delete(spriteKey);
      sprite = undefined;
    }
    if (sprite && artHandle && shipArtSwap(ctx.art, sprite, artHandle) !== 'keep') {
      ctx.shipContainer.removeChild(sprite);
      ctx.mountVisuals.removeShip(spriteKey);
      ctx.spriteBuildSigs.delete(spriteKey);
      sprite.destroy({ children: true });
      ctx.sprites.delete(spriteKey);
      sprite = undefined;
    }
    if (!sprite) {
      if (entry.kind === 1) {
        // Drones use the same procedural shape as player ships of that
        // kind, so a Heavy drone visibly reads as a Heavy. Falls back
        // to the legacy magenta dart silhouette when the wire didn't
        // carry a kind (older snapshots / pre-v2 packets).
        const sk = entry.shipKind;
        sprite = sk
          ? buildArtShipSprite(artHandle, () => buildShipGfxFromShape(shapeForKind(sk)))
          : buildDroneGfx(entry.radius);
        // P3c — a kind with a CHARGE weapon gets a (hidden) wind-up telegraph,
        // built once here and toggled per frame from `entry.charging`.
        const chargeRange = chargeRangeForKind(entry.shipKind);
        if (chargeRange > 0) {
          const tele = buildChargeTelegraphGfx(entry.radius, chargeRange);
          tele.visible = false;
          sprite.addChild(tele);
          chargeTelegraphs.set(sprite, tele);
        }
      } else if (entry.kind === 2) {
        // Structures (pose-core kind 2): a per-subtype tinted polygon read from
        // the shared shipKind byte (structures plan, Phase 2).
        const stKind = entry.shipKind, stRadius = entry.radius;
        sprite = buildArtShipSprite(artHandle, () => buildStructureGfx(stKind, stRadius));
        // WS-4 Phase 5 (R2.16) — a Miner shows a faint dashed mining-range ring
        // at its `miningRange` radius. Built HERE (the once-per-sprite create
        // path, invariant #14 — never per-frame) and parented to the body so it
        // tracks the structure. Only the Miner has a miningRange; others skip.
        const miningRange = minerRangeForKind(entry.shipKind);
        if (miningRange) sprite.addChild(buildMinerRangeRingGfx(miningRange));
        // WS-9 (R2.12) — the Capital shows its mineral bank as a world-space
        // number below the body. Built ONCE here (invariant #14).
        if (entry.shipKind === 'capital') sprite.addChild(buildCapitalResourceText(entry.radius));
        // Phase-1 issue 7 — a Battery shows its stored power as a world-space
        // number (the doc's "actual numbers for the stored capacity").
        if (entry.shipKind === 'battery') sprite.addChild(buildBatteryChargeText(entry.radius));
        // Phase-1 issue 2 — every structure carries an (initially empty)
        // build-ETA countdown child, shown only while it's an unbuilt blueprint.
        sprite.addChild(buildBuildEtaText(entry.radius));
      } else if (entry.kind === 3) {
        // Scrap (pose-core kind 3, scrap-on-death): one component of a dead
        // ship. Renders that component's recentred sub-shapes from the parent
        // ship-kind (entry.shipKind) + componentIndex, so the piece looks like
        // the part it broke off. Pose path below reads the resolved
        // single-per-frame pose (the drone kinematic-follower branch) so the
        // sprite matches the predWorld collision body (Phase-5 desync fix).
        const parentKind = entry.shipKind, component = entry.componentIndex ?? 0;
        sprite = buildArtShipSprite(artHandle, () => buildScrapGfx(parentKind, component));
        // A6 — wreckage starts hot (loot pods ride this channel too: they don't).
        if (parentKind !== 'cargo-pod') scrapBorn.set(sprite, now);
      } else if (entry.kind === 4) {
        // Capital wreck piece (S2b/S3): its shape from the shared deterministic
        // geometry (the server's body is built from the same), textured with
        // the dead ship's own baked art once ready (else the plain polygon),
        // its cut edges glowing from the wreck's death tick. Built once per
        // piece; the first piece of a fresh wreck plays the break-up.
        const desc = wreckDescs!.get(entry.wreckId!)!;
        const pieces = ctx.wrecks!.geometryFor(desc);
        const index = entry.componentIndex ?? 0;
        const g = pieces?.[index];
        if (pieces == null || g === undefined) continue; // unusable descriptor / bad index: not drawn
        const pose = resolveEntityDisplayPose(entry, ctx.swarmPoseScratch);
        const info = ctx.wreckArt !== undefined
          ? ctx.wreckArt.infoFor(desc, pieces, index, pose, entry.lastUpdateTick, fxNow)
          : coolWreckInfo(desc);
        const shipArt = wreckArtHandle !== null && wreckArtHandle.state === 'ready' ? wreckArtHandle.ship : null;
        sprite = new WreckPieceSprite(g, entry.shipKind ?? desc.parentKind, shipArt, info, index);
      } else {
        const rockRadius = entry.radius;
        sprite = buildArtShipSprite(artHandle, () => buildAsteroidGfx(entityId, rockRadius));
        // P2c — ice and crystal-veined rocks read apart from plain rock (the
        // Machined rock bakes its resource colour instead).
        // (Applied in the per-frame tint block below, the one tint site.)
      }
      ctx.shipContainer.addChild(sprite);
      ctx.sprites.set(spriteKey, sprite);
      ctx.spriteKinds.set(spriteKey, entry.kind); // #20 — track kind for recycle detection
      // Campaign 3.2 — full build signature (create-path alloc only, #14).
      ctx.spriteBuildSigs.set(spriteKey, {
        shipKind: entry.shipKind ?? null,
        componentIndex: entry.componentIndex ?? 0,
        radius: entry.radius,
        wreckId: entry.wreckId ?? 0,
      });
    }
    // Drones (kind 1) AND scrap (kind 3): read the already-resolved
    // single-per-frame pose that `ColyseusClient.updateMirror` wrote (the
    // kinematic-follower path — so the sprite matches the predWorld collision
    // body, one-pose-per-frame). Asteroids (0) + structures (2): render-now
    // interpolation off the poseRing (they are static server-side — see the
    // file docstring).
    const lerped = entry.kind === 1 || entry.kind === 3 || entry.kind === 4
      ? resolveEntityDisplayPose(entry, ctx.swarmPoseScratch)
      : interpolateSwarmPose(entry, now, ctx.swarmPoseScratch);
    sprite.x = lerped.x;
    sprite.y = -lerped.y;
    // A3 — don't draw structures that are off screen (static, so the bounding
    // radius is a safe margin; mount barrels are children and hide with it).
    if (entry.kind === 2) sprite.visible = isSpriteInView(sprite.x, sprite.y, entry.radius, ctx.viewBounds);
    // W2a — an NPC on its warp run is out of the world: hidden (WarpFx draws
    // the departure from its spool pose), like a remote pilot's ship.
    else if (entry.kind === 1) sprite.visible = entry.warp !== 2;
    sprite.rotation = -lerped.angle;
    if (entry.kind === 1 || entry.kind === 3) updateArtShipLight(ctx.art, sprite); // ships + tumbling scrap
    else if (entry.kind === 4 && sprite instanceof WreckPieceSprite) {
      sprite.update(fxNow, ctx.art.sunAz); // S3 light frame + cut-edge glow (game clock)
      // A held dying hull hands over to its pieces the frame ALL of them are
      // drawn; until then the hold hides the ones that have arrived (so it is
      // shown again here every frame). Sub-capital debris (permanent, ~100×
      // as many) is not drawn off screen; a capital wreck keeps today's
      // behaviour (every piece drawn).
      sprite.visible = sprite.info.profile === 'capital' || isSpriteInView(sprite.x, sprite.y, entry.radius, ctx.viewBounds);
      if (ctx.dyingHulls !== undefined) {
        const desc = wreckDescs!.get(entry.wreckId!)!;
        const total = ctx.wrecks!.geometryFor(desc)?.length ?? 0;
        ctx.dyingHulls.notePiece(entry.shipKind ?? desc.parentKind, entry.wreckId!, total, sprite);
      }
    }
    if (entry.kind === 1) {
      // P3c — charge-weapon wind-up telegraph (pulses while charging).
      const tele = chargeTelegraphs.get(sprite);
      if (tele !== undefined) {
        const on = entry.charging === true;
        tele.visible = on;
        if (on) tele.alpha = 0.45 + 0.4 * Math.sin(now / 70);
      }
      // P4a — a named elite wears a slowly-pulsing gold ring.
      let ring = eliteRings.get(sprite);
      if (entry.eliteName !== undefined && ring === undefined) {
        ring = buildEliteRingGfx(entry.radius);
        sprite.addChild(ring);
        eliteRings.set(sprite, ring);
      }
      if (ring !== undefined) {
        ring.visible = entry.eliteName !== undefined;
        if (ring.visible) ring.alpha = 0.7 + 0.3 * Math.sin(now / 400);
      }
    }
    if (entry.kind === 1 && entry.shipKind) {
      ctx.mountVisuals.ensureForShip(spriteKey, entry.shipKind, sprite);
      const swarmKind = getShipKind(entry.shipKind);
      const swarmMounts = swarmKind.mounts ?? EMPTY_MOUNTS;
      if (swarmMounts.length > 0) {
        ctx.mountVisuals.applyMountAngles(spriteKey, swarmMounts, entry.displayMountAngles ?? entry.mountAngles);
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
        // B2 — an NPC turret can aim at a player ship (no swarm entity).
        const targetEntry = targetId !== undefined
          ? mirror.swarm.get(targetId)
          : st?.turretTargetPlayerId !== undefined
            ? mirror.ships.get(st.turretTargetPlayerId)
            : undefined;
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
        // Coastal defences — a DEFENCE structure's guns are aimed by the
        // server's fire control (per-mount targets, lead, traverse) and their
        // angles ride the snapshot (`row.mountAngles`; the server is the only
        // writer, #12): ease toward those, a little faster than the traverse so
        // the drawn barrel never lags a 100 ms turret tick. Only the Miner's
        // drill still aims from its target here.
        const serverAngles = sk.weaponRange !== undefined ? st?.mountAngles : undefined;
        const defence = sk.weaponRange !== undefined;
        for (let i = 0; i < structMounts.length; i++) {
          const mount = structMounts[i]!;
          // Desired bearing in the mount's arc-local frame (canonical aim
          // convention forward = +y, right = +x ⇒ worldBearing = atan2(-dx, dy)),
          // or 0 (base) with no target. `rotateMountToward` clamps to the arc +
          // limits per-frame travel; `applyMountAngles` draws -(baseAngle+arc).
          let desiredArc = 0;
          if (defence) {
            desiredArc = serverAngles !== undefined && i < serverAngles.length ? serverAngles[i]! : 0;
            const nextArc = rotateMountToward(slew[i] ?? 0, desiredArc, mount, slewDtSec * SERVER_AIM_CATCH_UP);
            slew[i] = nextArc;
            _structureMountAngles.push(nextArc);
            continue;
          }
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
    // A capital never washes its whole hull red: a fighter's bolt on a 5,000 u
    // battleship read as the battleship itself flashing (review 2026-11-07).
    const capital = entry.kind === 1 && entry.shipKind !== undefined && getShipKind(entry.shipKind).sizeClass === 'capital';
    if (
      !capital && (
        mirror.damagedShips?.has(spriteKey) ||
        ctx.localHitTargets.has(spriteKey) ||
        ctx.remoteHitTargets.has(spriteKey))
    ) {
      sprite.tint = DAMAGE_FLASH_COLOR;
    } else {
      // v4 M2 — a patrol ship wears its faction's colour (set here, the one
      // tint site, so the reset below a hit can't wipe it).
      // A Machined patrol has its faction paint baked in, so it stays untinted.
      const fc = entry.kind === 1 && entry.faction !== undefined && !(sprite instanceof MachinedShipSprite)
        ? npcFactionDef(entry.faction)?.color
        : entry.kind === 0 && !isMachinedSprite(sprite)
          ? classicRockTint(entry.asteroidResource)
          : entry.kind === 3
            ? scrapHeatTint(now - (scrapBorn.get(sprite) ?? -Infinity))
            : undefined;
      const tint = fc ?? 0xffffff;
      // A wreck piece's tint is white unless hit: write it only on a change,
      // so settled debris does no per-frame tint work (sub-cap slice 4).
      if (entry.kind !== 4 || sprite.tint !== tint) sprite.tint = tint;
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
      // Phase-1 issue 2 — the in-world build-ETA countdown (CHANGE-only update;
      // the 1 Hz pulse re-supplies etaMs so the seconds tick without per-frame
      // re-raster). Empty once built.
      const etaText = sprite.getChildByLabel('buildEta') as Text | null;
      if (etaText) {
        const nextEta = st && !st.built ? formatBuildEta(st.etaMs) : '';
        if (etaText.text !== nextEta) etaText.text = nextEta;
      }
      // Phase-1 issue 7 — the Battery's stored-power number (CHANGE-only).
      if (entry.shipKind === 'battery') {
        const batText = sprite.getChildByLabel('batteryCharge') as Text | null;
        if (batText) {
          const next =
            st?.storedPowerMax !== undefined && st.storedPowerMax > 0
              ? `${Math.round(st.storedPower ?? 0)}/${Math.round(st.storedPowerMax)}`
              : '';
          if (batText.text !== next) batText.text = next;
        }
      }
    }
    // Sleeping entries stop interpolating; their pose is whatever the
    // server last shipped.
  }
}
