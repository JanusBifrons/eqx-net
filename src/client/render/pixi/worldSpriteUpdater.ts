/**
 * Frame passes 1-2 of `PixiRenderer.update()`: the world's entity sprites —
 * lifted out of `PixiRenderer` (god-file split, slice 7).
 *
 * `updateEntitySprites` runs hit targets, ships (with re-keys and death
 * explosions), the connector web, swarm sprites, far-zoom icons, turret shots,
 * the lit scene and the unseen-sprite sweep; `updateProjectilesAndGhost` runs
 * projectiles, missiles, the new explosions' tick and the server ghost. Both
 * read the pooled frame ctx (`frameCtx.ts`) and allocate nothing (#14).
 */

import type { RenderMirror } from '@core/contracts/IRenderer';
import { fillHitTargetSets } from './hitTargetSets.js';
import { updateShipSprites } from './shipSpriteUpdater.js';
import { updateSwarmSprites } from './swarmSpriteUpdater.js';
import { noteDyingHulls } from './dyingHullHold.js';
import { sweepUnseenSprites } from './spriteSweep.js';
import { deathBlastFor, dyingHullDiameter, hullDeathBlastReplaced } from './deathBlast.js';
import { spawnVaporiseBlast } from './vaporiseBlast.js';
import { updateProjectileSprites } from './projectileSpriteUpdater.js';
import { updateMissileSprites } from './missileSpriteUpdater.js';
import { noteTurretShots } from './turretShotUpdater.js';
import { feedLitScene } from './litSceneUpdater.js';
import { buildGhostGfx } from './spriteBuilders.js';
import { decideExplosionPosition } from '../spriteUpdateDecisions';
import { MachinedShipSprite } from '../art/MachinedShipSprite.js';
import { blastRadiusFor } from '../art/fx/FxExplosions.js';
import { forEachShipRekey } from '../shipRekey.js';
import type { RendererFrameCtx } from './frameCtx.js';

/** Hit targets, ship sprites + death explosions, connector web, swarm, sweep. */
export function updateEntitySprites(mirror: RenderMirror, ctx: RendererFrameCtx): void {
  const r = ctx.r;
  // 2026-05-25 heap-growth gate step 6: reuse persistent scratch
  // containers instead of `new Set<string>()` per frame.
  const seen = r.seenScratch;
  seen.clear();

  // Per-frame hit-target sets — see pixi/hitTargetSets.ts.
  const remoteHitTargets = r.remoteHitTargets;
  const localHitTargets = r.localHitTargets;
  fillHitTargetSets(mirror, remoteHitTargets, localHitTargets);

  // Active-ship sprite update — sprite creation, pose, tint, thrust
  // + boost flames. See pixi/shipSpriteUpdater.ts. Ctx pooled to
  // `r.shipUpdaterCtx` (heap-growth gate step 12) — same fields
  // every frame, no per-call literal allocation.
  r.mountVisuals.setLocalAim(mirror.localPlayerId, mirror.localAimMountIds);
  r.cameraDirector.applyHullZoom(mirror);
  r.mountVisuals.setFrame(r.fxNow(), r.effects?.getQuality() ?? 'medium');
  // Seamless hand-over (RTS Part A): move re-keyed ships' state BEFORE the
  // sprite pass, so it finds each sprite under its new key (no rebuild).
  forEachShipRekey(mirror.pendingShipRekeys, r.rekeyShip);
  updateShipSprites(mirror, r.shipUpdaterCtx);

  // Explosion sprites spawned this frame for destroyed ships.
  // 2026-05-13 — the "explosion appeared at zero zero" bug (a parked
  // hull's sprite lived in a separate map). Since RTS Part A S3 every
  // ship's sprite is in `r.sprites` (active by playerId, parked by
  // shipInstanceId). Helper in `spriteUpdateDecisions.ts`, unit-tested.
  // A capital dying into a wreck stays drawn until its pieces are (marked
  // here while its sprite is still mapped; the sweeps below hand it over).
  noteDyingHulls(mirror.explodingShips, mirror.capitalWrecks, r.spriteShipKind, r.dyingHulls, r.fxNow(), mirror.subcapWrecks, mirror.vaporisedShips);
  spawnShipExplosions(mirror, ctx);

  // Advance and remove expired explosion sprites (only the legacy
  // fallback path uses this; the EffectsService manages its own
  // particles + shock filters in its tick).
  ctx.explosionSprites.tick(r.shipContainer);

  // Structures plan, Phase 3 — grid connector web (behind sprites). Joins
  // mirror.structures → mirror.swarm positions; no-op when no structures.
  // Item C: feed the connector preview the pointer-chosen ghost point (so the
  // preview lines emanate from where the ghost is actually drawn), then read
  // the would-connect count back into the feedback channel.
  r.connectorRenderer.ghostWorldX = r.input._placementChosenX;
  r.connectorRenderer.ghostWorldY = r.input._placementChosenY;
  // Phase 5 — bolder defensive range ring on the hovered/selected turret. The
  // selection/hover ids are `swarm-<entityId>` (structures ride the swarm
  // channel); prefer the selected one.
  const highlightedSel = r.input._focusId ?? r.input._hoveredId;
  r.connectorRenderer.highlightedStructureId =
    highlightedSel !== null && highlightedSel.startsWith('swarm-')
      ? parseInt(highlightedSel.slice('swarm-'.length), 10)
      : null;
  r.connectorRenderer.update(mirror, r.world.scale.x, r.fxNow());
  r.feedback.placementPreviewConnectionCount =
    r.connectorRenderer.placementPreviewConnectionCount;
  // WS-D (#21) — built-turret defensive range-circle count. DEV hook only (not
  // a RendererFeedback field — that grows the per-frame worker payload and is
  // phase-gated; the unit lock is the primary regression guard). Main-thread
  // render path only, like __eqxGalaxyBadgeCount, so the E2E runs ?worker=0.
  (globalThis as { __eqxBuiltTurretRangeCount?: number }).__eqxBuiltTurretRangeCount =
    r.connectorRenderer.builtTurretRangeCount;

  // Phase 5c swarm sprites (asteroids + drones) — see
  // pixi/swarmSpriteUpdater.ts. Ctx pooled to `r.swarmUpdaterCtx`.
  // P3.8 — feed the structure-mount slew its dt (clamped so a tab-resume /
  // first-frame gap eases rather than teleporting).
  // eslint-disable-next-line no-restricted-properties -- real time: swarm poses are wall-stamped arrivals
  const swarmNow = performance.now();
  r.swarmUpdaterCtx.slewDtSec =
    ctx.lastSwarmUpdateNow > 0
      ? Math.min(0.05, Math.max(0, (swarmNow - ctx.lastSwarmUpdateNow) / 1000))
      : 1 / 60;
  ctx.lastSwarmUpdateNow = swarmNow;
  r.swarmUpdaterCtx.viewBounds = r.camera.visibleBoundsInto(ctx.swarmViewScratch);
  r.swarmUpdaterCtx.fxNowMs = r.fxNow(); // wreck glow follows the game speed
  r.swarmUpdaterCtx.cameraScale = r.world.scale.x; // wreck-piece far-zoom LOD
  r.swarmUpdaterCtx.wreckFarLayer = r.wreckFarLayer;
  updateSwarmSprites(mirror, r.swarmUpdaterCtx);
  r.farIcons.update(mirror, r.sprites, r.world.scale.x);
  noteTurretShots(mirror, r.turretShotCtx); // pixi/turretShotUpdater.ts
  r.litSceneCtx.tractorViewCount = ctx.tractorViewCount;
  feedLitScene(mirror, r.litSceneCtx); // pixi/litSceneUpdater.ts

  // Sprites whose entity left the mirror this frame. Boost flame and
  // mount-visual cluster are children — destroy({ children: true }) frees
  // them too, but the map entries go so a respawn rebuilds cleanly. A
  // capital that died leaving a wreck is held (drawn) until its pieces are.
  sweepUnseenSprites(r.sprites, seen, r.forgetSprite, r.dyingHulls, r.fxNow());
}

/** Explosion sprites spawned this frame for destroyed ships. */
function spawnShipExplosions(mirror: RenderMirror, ctx: RendererFrameCtx): void {
  const r = ctx.r;
  if (mirror.explodingShips) {
    for (const targetId of mirror.explodingShips) {
      // PRESERVE the decideExplosionPosition lookup (the 2026-05-13 fix):
      // the dying ship's mirror entry is already gone (killEntity), so the
      // pose comes from its still-mapped SPRITE, never a (0,0) default.
      const pose = decideExplosionPosition({
        targetId,
        shipSprites: r.sprites,
      });
      if (!pose) continue; // ship not in any map — skip the VFX

      // M4 (effects subsystem plan `wiggly-puppy`): dispatch to the
      // EffectsService when present; fall back to today's inline
      // buildExplosionGfx path under the ?effects=0 escape hatch. The
      // pose returned by the helper is in Pixi space (Y-flipped); the
      // effects service expects world coords, so unflip here.
      // New explosions (B4): sized from the dying sprite; replaces the
      // particle burst + shock filter when its textures are ready.
      const dying = r.sprites.get(targetId);
      // Burned away by a cut kill (fracture v11): no wreck follows.
      const vaporised = mirror.vaporisedShips?.has(targetId) === true;
      // Capital wrecks on: a dying capital explodes where it broke (the wreck
      // break-up at its kill point), not as a hull-sized blast over the whole
      // hull (money-shot review).
      if (hullDeathBlastReplaced(mirror.capitalWrecks, dying instanceof MachinedShipSprite && dying.capital, r.spriteShipKind(targetId), vaporised)) {
        ctx.hullBlastsReplaced++;
        continue;
      }
      const diameter = dyingHullDiameter(dying, r.spriteShipKind(targetId)); // a parked hull: its kind's size
      // A sub-cap breaking into wreck pieces (welcome `subcapWrecks`) gets a
      // smaller blast with shorter smoke (profile fx.deathBlastScale/Linger).
      const db = deathBlastFor(mirror.subcapWrecks, mirror.capitalWrecks, r.spriteShipKind(targetId), ctx.deathBlastScratch, vaporised);
      // The vaporise variant (flash, glow, ash puff; no fireball, smoke or
      // wreck); its art not ready: fall through to today's fallback below.
      if (db.vaporise && spawnVaporiseBlast(r.effects, r.fxExplosions, pose.x, -pose.y, diameter, r.fxNow(), db)) continue;
      if (!db.vaporise && r.fxExplosions?.spawn(pose.x, -pose.y, blastRadiusFor(diameter) * db.scale, r.fxNow(), db.linger)) {
        // drawn by FxExplosions
      } else if (r.effects) {
        r.effects.spawnBurst('destruction', pose.x, -pose.y);
        r.effects.triggerOneShotFilter('destruction-shock', pose.x, -pose.y);
      } else {
        ctx.explosionSprites.spawn(r.shipContainer, pose.x, pose.y);
      }
    }
  }
}

/** Projectile, missile and server-ghost sprites; the new explosions' tick. */
export function updateProjectilesAndGhost(mirror: RenderMirror, ctx: RendererFrameCtx): void {
  const r = ctx.r;
  // Projectile + ghost-projectile sprites — see pixi/projectileSpriteUpdater.ts.
  // Ctx pooled to `r.projectileUpdaterCtx`.
  r.projectileUpdaterCtx.cameraScale = r.world.scale.x;
  updateProjectileSprites(mirror, r.projectileUpdaterCtx);

  // Missile sprites + detonation VFX. Reads single-pose-per-frame via
  // resolveMissileDisplayPose (one-pose-per-frame rule — same as drones).
  // eslint-disable-next-line no-restricted-properties -- real time: missile poses are wall-stamped arrivals
  updateMissileSprites(mirror, r.missileUpdaterCtx, performance.now());
  r.fxExplosions?.tick(r.fxNow());

  // Server ghost: the debug marker showing where the server's last snapshot
  // put the ship, before any client-side prediction replay. OFF unless the
  // player switches it on in Settings (2026-11-06; it used to default on).
  // `?cleanworld=1` (showcase capture) never shows it.
  const ghostEnabled = !r.cleanWorld && mirror.showServerGhost === true;
  if (ghostEnabled && mirror.serverGhostPos) {
    if (!ctx.serverGhost) {
      ctx.serverGhost = buildGhostGfx();
      r.shipContainer.addChild(ctx.serverGhost);
    }
    ctx.serverGhost.visible = true;
    ctx.serverGhost.x = mirror.serverGhostPos.x;
    ctx.serverGhost.y = -mirror.serverGhostPos.y;
  } else if (ctx.serverGhost) {
    ctx.serverGhost.visible = false;
  }
}
