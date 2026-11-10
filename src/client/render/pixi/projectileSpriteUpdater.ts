/**
 * Per-frame projectile + ghost-projectile sprite update — lifted out
 * of `PixiRenderer.update()`.
 *
 * Each projectile in `mirror.projectiles` gets a sprite the first
 * time we see its id; the sprite's appearance is driven by:
 *   - `proj.beam`     — a hitscan beam (line); built from the (x,y)
 *                       → (toX, toY) delta with Y flipped for Pixi.
 *   - `proj.weaponId === 'laser'` — a rotating bolt sprite, rotated
 *                       to face its velocity heading.
 *   - default         — a procedural projectile sprite (ghost variant
 *                       when `proj.isGhost`).
 *
 * Sprites missing from this frame's map are destroyed.
 */

import type { Container, Graphics } from 'pixi.js';
import { fxProjectileStyle, type FxProjectiles } from '../art/fx/FxWeapons.js';
import { getWeapon, isWeaponId, type WeaponId } from '@core/combat/WeaponCatalogue';
import type { RenderMirror } from '@core/contracts/IRenderer';
import {
  buildBeamGfx,
  buildLaserBoltGfx,
  buildProjectileGfx,
  buildPulseOrbGfx,
} from './spriteBuilders.js';
import { minScreenSizeMul, SHELL_MIN_SCREEN_PX } from '../incoming/incomingFire.js';

/** FxProjectiles SHELL width per unit of shell size, and the classic dot's
 *  diameter (`buildProjectileGfx`): what the min-size floor measures. */
const FX_SHELL_WIDTH = 4;
const CLASSIC_DOT_DIAMETER = 8;

/** A shell's drawn size is its gun's shell radius (FxProjectiles SHELL). */
function shellSize(id: WeaponId): number {
  const w = getWeapon(id);
  return w.mode === 'hitscan' ? 1 : w.radius;
}

export interface ProjectileSpriteCtx {
  shipContainer: Container;
  projectileSprites: Map<string, Graphics>;
  projSeenScratch: Set<string>;
  /** New bolt / tracer look (`?fx=new`, plan iridescent-seeking-rainbow v3
   *  B3); null or not ready = today's shapes. */
  fx?: FxProjectiles | null;
  /** Camera scale (px per u) this frame: far naval shells are drawn at least
   *  `SHELL_MIN_SCREEN_PX` wide (a 6 u shell is ~0.2 px at a battleship's
   *  zoom-out floor). Absent = 1. */
  cameraScale?: number;
}

export function updateProjectileSprites(
  mirror: RenderMirror,
  ctx: ProjectileSpriteCtx,
): void {
  if (!mirror.projectiles) return;
  const projSeen = ctx.projSeenScratch;
  projSeen.clear();
  const fx = ctx.fx && ctx.fx.ready() ? ctx.fx : null;
  fx?.beginFrame();
  for (const [projId, proj] of mirror.projectiles) {
    projSeen.add(projId);
    let ps = ctx.projectileSprites.get(projId);
    if (!ps) {
      if (proj.beam) {
        const dx = proj.beam.toX - proj.x;
        const dy = -(proj.beam.toY - proj.y); // Y-flip for Pixi
        ps = buildBeamGfx(dx, dy);
      } else if (proj.weaponId === 'laser') {
        ps = buildLaserBoltGfx();
      } else if (proj.weaponId === 'pulse-orb') {
        ps = buildPulseOrbGfx();
      } else {
        ps = buildProjectileGfx(proj.isGhost ?? false);
      }
      ctx.shipContainer.addChild(ps);
      ctx.projectileSprites.set(projId, ps);
    }
    ps.x = proj.x;
    ps.y = -proj.y;
    ps.alpha = proj.alpha ?? 1;
    const naval = !proj.beam && proj.weaponId !== undefined && proj.weaponId.startsWith('naval_');
    const camScale = ctx.cameraScale ?? 1;
    const style = fx ? fxProjectileStyle(proj.weaponId, !!proj.beam) : null;
    ps.visible = style === null;
    if (style) {
      let size = style === 'shell' && isWeaponId(proj.weaponId) ? shellSize(proj.weaponId) : 1;
      if (naval) size *= minScreenSizeMul(FX_SHELL_WIDTH * size, camScale, SHELL_MIN_SCREEN_PX);
      fx!.draw(projId, style, proj.x, proj.y, proj.vx, proj.vy, proj.alpha ?? 1, size);
    } else if (naval) {
      ps.scale.set(minScreenSizeMul(CLASSIC_DOT_DIAMETER, camScale, SHELL_MIN_SCREEN_PX));
    }
    // Rotate laser bolts to face their velocity heading.
    if (proj.weaponId === 'laser' && !proj.beam) {
      ps.rotation = -Math.atan2(proj.vy, proj.vx) + Math.PI / 2;
    }
  }
  fx?.endFrame();
  for (const [projId, ps] of ctx.projectileSprites) {
    if (!projSeen.has(projId)) {
      ctx.shipContainer.removeChild(ps);
      ps.destroy();
      ctx.projectileSprites.delete(projId);
    }
  }
}
