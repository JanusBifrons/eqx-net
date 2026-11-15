/**
 * The vaporise death blast (fracture v11: a cut kill burned the whole hull
 * away): a weapon-tinted flash, a short glow and a puff of glowing ash over
 * the hull; no fireball, smoke or wreck. Split out of `PixiRenderer.ts`
 * (god-file budget).
 */
import type { Container } from 'pixi.js';
import type { EffectsService } from '../../effects/EffectsService';
import { blastRadiusFor, type FxExplosions } from '../art/fx/FxExplosions.js';
import type { DeathBlast } from './deathBlast.js';

/** The smallest vaporise blast radius (world units): a fighter's still reads
 *  at fight zoom, past the 60 u heavy beam that is on it at the kill. */
export const VAPORISE_MIN_RADIUS = 70;

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
  const r = Math.max(VAPORISE_MIN_RADIUS, blastRadiusFor(diameter) * db.scale);
  ashOpts.radius = Math.max(diameter / 2, r * 0.6);
  ashOpts.tint = db.tint;
  effects?.spawnBurst('wreck-ash', x, y, ashOpts);
  return fx?.spawnVaporise(x, y, r, nowMs, db.tint, db.seconds) === true;
}

/** Stacks the vaporise flash layer on top of `ships` (call once, after the
 *  beam containers are added): the beam is still on the hull at the kill. */
export function stackVaporiseOverBeams(ships: Container, fx: FxExplosions | null): void {
  if (fx) ships.addChild(fx.overLayer);
}
