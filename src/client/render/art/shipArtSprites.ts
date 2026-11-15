/**
 * Machined art — the one place an entity sprite switches between today's
 * vector look and the Machined look: ships, drones, lingering hulls and scrap
 * (cross-faded sun frames), structures and asteroids (one lit frame).
 *
 * Each sprite key keeps its art handle; the handle is re-acquired only when
 * what it was built from changes (rare), so the per-frame check is a map
 * lookup and a few compares (invariant #14).
 */
import { teamColorOf, teamEdgeOf, teamSigilOf, type LiveryEdge } from '../../../shared-types/factions.js';
import type { Container } from 'pixi.js';
import { decideArtSwap, type ArtSwap } from '../spriteUpdateDecisions.js';
import type { ArtHandle, ArtService } from './ArtService.js';
import { quarterTurns } from './bake.js';
import { MachinedFlatSprite } from './MachinedFlatSprite.js';
import { MachinedShipSprite } from './MachinedShipSprite.js';
import { hasTurrets } from './turretLayout.js';
import { isCapitalKindId } from './capitalKind.js';

export interface ShipArtCtx {
  /** Null when the Machined look is off: everything draws today's look. */
  art: ArtService | null;
  /** Each sprite key's current art handle (deleted with the sprite). */
  handles: Map<string, ArtHandle>;
  /** The sun's world azimuth (Pixi space) the art was lit by. */
  sunAz: number;
  /** Machined turrets (new effects): ringed hull / deck bakes and baked guns. */
  turrets?: boolean;
  /** Ship livery treatment (`?livery=`, look R&D); absent = today's paint. */
  livery?: import('./fields.js').LiveryTreatment;
}

/** The handle a ship should use now (re-acquired only on a kind/paint change). */
/** `team`/`sigil`/`edge` (owner colours): with `actx.livery` set and a team
 *  given, the hull is liveried (sigil defaults to the team colour). The change check
 *  compares scalars only; the Livery object is built only on re-acquire. */
export function shipHandleFor(
  actx: ShipArtCtx, key: string, kindId: string, paint: number | undefined, team?: number, sigil?: number, edge?: LiveryEdge,
): ArtHandle | null {
  if (!actx.art) return null;
  let h = actx.handles.get(key);
  const rings = actx.turrets === true && hasTurrets(kindId, false);
  const treat = team !== undefined ? actx.livery : undefined;
  const sig = sigil ?? team ?? 0;
  const lv = h?.job.type === 'ship' ? h.job.livery : undefined;
  const liveryChanged = treat === undefined
    ? lv !== undefined
    : lv === undefined || lv.treatment !== treat || lv.team !== team || lv.sigil !== sig || lv.edge !== edge;
  if (!h || h.stale === true || h.job.type !== 'ship' || h.job.id !== kindId || h.job.paint !== paint || (h.job.rings === true) !== rings || liveryChanged) {
    h = actx.art.ship(kindId, paint, true, rings, treat !== undefined && team !== undefined ? { treatment: treat, team, sigil: sig, ...(edge !== undefined ? { edge } : {}) } : undefined);
    actx.handles.set(key, h);
  }
  return h;
}

/** A structure's handle; its quarter turn is part of the bake. */
export function structHandleFor(actx: ShipArtCtx, key: string, kindId: string, rot: number): ArtHandle | null {
  if (!actx.art) return null;
  let h = actx.handles.get(key);
  const rings = actx.turrets === true && hasTurrets(kindId, true);
  if (!h || h.stale === true || h.job.type !== 'struct' || h.job.id !== kindId || (!h.job.lit && quarterTurns(h.job.rot ?? 0) !== quarterTurns(rot)) || (h.job.rings === true) !== rings) {
    h = actx.art.struct(kindId, 1, rot, undefined, true, rings);
    actx.handles.set(key, h);
  }
  return h;
}

/** A scrap piece's handle (parent ship kind + component). */
export function scrapHandleFor(actx: ShipArtCtx, key: string, parentKind: string, component: number): ArtHandle | null {
  if (!actx.art) return null;
  let h = actx.handles.get(key);
  if (!h || h.stale === true || h.job.type !== 'scrap' || h.job.id !== parentKind || h.job.component !== component) {
    h = actx.art.scrap(parentKind, component);
    actx.handles.set(key, h);
  }
  return h;
}

/** An asteroid's handle. Its turn is taken once, when first seen: a slowly
 *  turning rock keeps that lighting rather than re-baking as it turns. */
export function rockHandleFor(
  actx: ShipArtCtx, key: string, entityId: number, radius: number, resource: string | undefined, rot: number,
): ArtHandle | null {
  if (!actx.art) return null;
  let h = actx.handles.get(key);
  if (!h || h.stale === true || h.job.type !== 'rock' || h.job.entityId !== entityId || h.job.radius !== radius || h.job.resource !== resource) {
    h = actx.art.rock(entityId, radius, resource, rot);
    actx.handles.set(key, h);
  }
  return h;
}

/** True when the sprite already shows this handle's art. */
function showsArt(sprite: Container | undefined, h: ArtHandle | null): boolean {
  if (sprite instanceof MachinedShipSprite) return h === null || sprite.art === h.ship;
  if (sprite instanceof MachinedFlatSprite) return h === null || sprite.art === h.struct;
  return false;
}

/** What to do with the cached sprite this frame. */
export function shipArtSwap(actx: ShipArtCtx, sprite: Container | undefined, h: ArtHandle | null): ArtSwap {
  return decideArtSwap(actx.art !== null, h ? h.state : null, showsArt(sprite, h));
}

/** A new sprite for a swap or a first build: Machined if its art is ready. */
export function buildArtShipSprite(h: ArtHandle | null, classic: () => Container): Container {
  if (h && h.state === 'ready') {
    if (h.ship) return new MachinedShipSprite(h.ship, h.job.type === 'ship' && isCapitalKindId(h.job.id));
    if (h.struct) return new MachinedFlatSprite(h.struct);
  }
  return classic();
}

/** True for a sprite drawing the Machined look (either kind). */
export function isMachinedSprite(sprite: Container): boolean {
  return sprite instanceof MachinedShipSprite || sprite instanceof MachinedFlatSprite;
}

/** Per-frame: slide a Machined ship's light to match its rotation. */
export function updateArtShipLight(actx: ShipArtCtx, sprite: Container): void {
  if (sprite instanceof MachinedShipSprite) sprite.updateLight(actx.sunAz);
}

/** A faction's livery (team colour, sigil seed, section-edge shape), cached
 *  per owner id so the frame loop never re-hashes; the entry is allocated
 *  once on first sight. */
export interface OwnerLivery { team: number; sigil: number; edge: LiveryEdge }
const ownerLiveries = new Map<string, OwnerLivery>();
export function ownerLivery(owner: string): OwnerLivery {
  let l = ownerLiveries.get(owner);
  if (!l) { l = { team: teamColorOf(owner), sigil: teamSigilOf(owner), edge: teamEdgeOf(owner) }; ownerLiveries.set(owner, l); }
  return l;
}
/** Wreckage whose owner is unknown wears neutral grey scrap under a livery. */
export const SCRAP_TEAM = 0x8a93a1;
