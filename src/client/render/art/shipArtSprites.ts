/**
 * Machined art — the one place a ship sprite switches between today's vector
 * look and the Machined look (players, drones and lingering hulls all call it).
 *
 * Each sprite key keeps its art handle; the handle is re-acquired only when
 * the ship's kind or paint changes (rare), so the per-frame check is a map
 * lookup and a few compares (invariant #14).
 */
import type { Container } from 'pixi.js';
import { decideArtSwap, type ArtSwap } from '../spriteUpdateDecisions.js';
import type { ArtHandle, ArtService } from './ArtService.js';
import { MachinedShipSprite } from './MachinedShipSprite.js';

export interface ShipArtCtx {
  /** Null when the Machined look is off: every ship draws today's look. */
  art: ArtService | null;
  /** Each sprite key's current art handle (deleted with the sprite). */
  handles: Map<string, ArtHandle>;
  /** The sun's world azimuth (Pixi space) the art was lit by. */
  sunAz: number;
}

/** The handle a ship should use now (re-acquired only on a kind/paint change). */
export function shipHandleFor(actx: ShipArtCtx, key: string, kindId: string, paint: number | undefined): ArtHandle | null {
  if (!actx.art) return null;
  let h = actx.handles.get(key);
  if (!h || h.job.type !== 'ship' || h.job.id !== kindId || h.job.paint !== paint) {
    h = actx.art.ship(kindId, paint);
    actx.handles.set(key, h);
  }
  return h;
}

/** What to do with the cached sprite this frame. */
export function shipArtSwap(actx: ShipArtCtx, sprite: Container | undefined, h: ArtHandle | null): ArtSwap {
  const isMachined = sprite instanceof MachinedShipSprite;
  const shows = isMachined && (h === null || (sprite as MachinedShipSprite).art === h.ship);
  return decideArtSwap(actx.art !== null, h ? h.state : null, shows);
}

/** A new sprite for a swap or a first build: Machined if its art is ready. */
export function buildArtShipSprite(h: ArtHandle | null, classic: () => Container): Container {
  return h && h.state === 'ready' && h.ship ? new MachinedShipSprite(h.ship) : classic();
}

/** Per-frame: slide a Machined sprite's light to match its rotation. */
export function updateArtShipLight(actx: ShipArtCtx, sprite: Container): void {
  if (sprite instanceof MachinedShipSprite) sprite.updateLight(actx.sunAz);
}
