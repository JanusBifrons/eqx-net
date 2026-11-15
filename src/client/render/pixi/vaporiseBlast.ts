/**
 * The vaporise death blast (fracture v11: a cut kill burned the whole hull
 * away): a weapon-tinted flash, a short glow and a puff of glowing ash over
 * the hull; no fireball, smoke or wreck. Split out of `PixiRenderer.ts`
 * (god-file budget).
 */
import type { EffectsService } from '../../effects/EffectsService';
import { blastRadiusFor, type FxExplosions } from '../art/fx/FxExplosions.js';
import type { DeathBlast } from './deathBlast.js';

/** The ash puff's burst opts (reused, #14). */
const ashOpts = { radius: 0, tint: 0 };

/**
 * Plays `db`'s vaporise variant at (`x`, `y`) (Pixi space) over a hull of
 * `diameter`. The ash puff always spawns (when effects are on); true when
 * `FxExplosions` drew the flash, false when its art is not ready (the caller
 * plays its fallback blast). Alloc-free.
 */
export function spawnVaporiseBlast(
  effects: EffectsService | null, fx: FxExplosions | null,
  x: number, y: number, diameter: number, nowMs: number, db: DeathBlast,
): boolean {
  ashOpts.radius = diameter / 2;
  ashOpts.tint = db.tint;
  effects?.spawnBurst('wreck-ash', x, y, ashOpts);
  return fx?.spawnVaporise(x, y, blastRadiusFor(diameter) * db.scale, nowMs, db.tint, db.seconds) === true;
}
