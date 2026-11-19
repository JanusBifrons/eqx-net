/**
 * Firing reactions for Machined guns (turrets T2) and naval shell impact
 * bursts — lifted out of `PixiRenderer.update()` (god-file split, Phase 4).
 *
 * `noteTurretShots(mirror, ctx)` tells `MountVisualManager` about held beams
 * by mount id and each bolt / missile the frame it first appears, matched to
 * its owner's nearest gun tip. The ctx, its seen-maps (stamped with the
 * frame's generation) and the owner id → sprite key cache are built once by
 * `createTurretShotCtx` (renderer construction); `init` sets `fxExplosions`.
 * Render-only; no wire change. Allocation-free per frame (invariant #14).
 */

import type { Container } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { MountVisualManager } from '../MountVisualManager';
import type { FxExplosions } from '../art/fx/FxExplosions.js';
import { NavalShellBursts } from '../art/fx/navalShellBursts.js';

export interface TurretShotCtx {
  mountVisuals: MountVisualManager;
  sprites: Map<string, Container>;
  fxNow: () => number;
  /** Set in `init` when the new effects are on. */
  fxExplosions: FxExplosions | null;
  /** Firing reactions (turrets T2): projectile / missile ids seen, stamped
   *  with the frame's generation so a new one is noticed once, and a cache of
   *  owner id → sprite key (structures fire as their bare entity id). */
  turretShotSeen: Map<string, number>;
  /** Naval shells in flight, for their impact bursts (game space). */
  navalShellBursts: NavalShellBursts;
  turretMissileSeen: Map<number, number>;
  turretShotGen: number;
  ownerSpriteKey: Map<string, string>;
}

export interface TurretShotCtxRefs {
  mountVisuals: MountVisualManager;
  sprites: Map<string, Container>;
  fxNow: () => number;
}

/** Build the turret-shot ctx once (renderer construction). */
export function createTurretShotCtx(refs: TurretShotCtxRefs): TurretShotCtx {
  return {
    mountVisuals: refs.mountVisuals, sprites: refs.sprites, fxNow: refs.fxNow, fxExplosions: null,
    turretShotSeen: new Map(), navalShellBursts: new NavalShellBursts(), turretMissileSeen: new Map(),
    turretShotGen: 0, ownerSpriteKey: new Map(),
  };
}

/** The sprite key a shooter id draws under (players and drones as-is,
 *  structures as `swarm-<id>`), or null when it has no sprite. */
function shooterSpriteKey(ctx: TurretShotCtx, id: string): string | null {
  if (ctx.sprites.has(id)) return id;
  let k = ctx.ownerSpriteKey.get(id);
  if (k === undefined) {
    if (ctx.ownerSpriteKey.size > 1024) ctx.ownerSpriteKey.clear();
    k = `swarm-${id}`;
    ctx.ownerSpriteKey.set(id, k);
  }
  return ctx.sprites.has(k) ? k : null;
}

/** Firing reactions for Machined guns (turrets T2): held beams by mount
 *  id, and each bolt / missile the frame it first appears, matched to its
 *  owner's nearest gun tip. Render-only; no wire change. */
export function noteTurretShots(mirror: RenderMirror, ctx: TurretShotCtx): void {
  const mv = ctx.mountVisuals;
  if (mv.machinedGunCount() <= 0) return;
  const gen = ++ctx.turretShotGen;
  const localId = mirror.localPlayerId;
  if (localId && mirror.liveBeams) for (const mountId of mirror.liveBeams.keys()) mv.noteBeam(localId, mountId);
  if (mirror.remoteLasers) {
    for (const [shooterId, perShooter] of mirror.remoteLasers) {
      const key = shooterSpriteKey(ctx, shooterId);
      if (key) for (const mountId of perShooter.keys()) mv.noteBeam(key, mountId);
    }
  }
  const now = ctx.fxNow();
  if (mirror.projectiles) for (const [id, p] of mirror.projectiles) {
    if (p.beam) continue; // instant beam lines: handled as beams
    if (!ctx.turretShotSeen.has(id)) {
      const key = shooterSpriteKey(ctx, p.ownerId);
      if (key) mv.noteShotNear(key, p.x, -p.y, p.weaponId, p.vx, -p.vy);
    }
    ctx.turretShotSeen.set(id, gen);
  }
  for (const [id, g] of ctx.turretShotSeen) if (g !== gen) ctx.turretShotSeen.delete(id);
  // Naval shells: burst only where a shell_end says a shell hit (slice 4;
  // a miss or a shell leaving view never bursts). Game space in, game
  // space to FxExplosions (review 2026-11-10: a Pixi-space -y here put
  // the burst at the Y mirror).
  ctx.navalShellBursts.frame(ctx.fxExplosions, now, mirror.pendingShellEnds);
  if (mirror.missiles) {
    for (const [id, m] of mirror.missiles) {
      if (!ctx.turretMissileSeen.has(id)) {
        const key = shooterSpriteKey(ctx, m.ownerId);
        if (key) mv.noteShotNear(key, m.x, -m.y);
      }
      ctx.turretMissileSeen.set(id, gen);
    }
    for (const [id, g] of ctx.turretMissileSeen) if (g !== gen) ctx.turretMissileSeen.delete(id);
  }
}
