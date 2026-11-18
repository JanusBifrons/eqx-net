/**
 * Per-frame engine exhaust (new `FxEngines` + today's particle emitters) and
 * shield aura (legacy ring + new `FxShields`) — lifted out of
 * `PixiRenderer.update()` (god-file split, Phase 4).
 *
 * `updateEngineShieldFx(mirror, ctx)` draws the new exhaust, then diffs
 * thrust / boost / shield-up sets against last frame's registrations and
 * fires `setContinuous` on transitions only. The ctx and its diff sets are
 * built once by `createEngineShieldFxCtx` (renderer construction, so the
 * sector-handoff reset is safe before `init`); `init` fills `fxEngines` /
 * `fxShields`, and the caller writes `effects` and `fxShieldsOn` (the shield
 * frame gate it opened, shared with beams and hit FX) before each call.
 * Allocation-free per frame (invariant #14).
 */

import type { Container } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { shieldBubbleRadius, shipTuning } from '@shared-types/shipScale/tuning';
import { DEFAULT_SHIP_KIND } from '../../../shared-types/shipKinds.js';
import { getShipKind } from '../../../shared-types/shipKinds';
import type { EffectsService } from '../../effects/EffectsService';
import { engineProfileForKind } from './engineGeometry.js';
import { droneBoostInput } from './droneEngineInput.js';
import { shieldBubbleRadiusForEntity } from './shieldBubbleRadius.js';
import { MachinedShipSprite } from '../art/MachinedShipSprite.js';
import { litPass } from '../art/litPass.js';
import { engineLightAstern, engineLightHeight, engineLightIntensity, engineLightReach } from '../art/lightingSettings.js';
import type { FxEngines } from '../art/fx/FxEngines.js';
import type { FxShields, ShieldPoseFn } from '../art/fx/FxShields.js';
import type { ShipArtCtx } from '../art/shipArtSprites.js';

export interface EngineShieldFxCtx {
  /** Written by the caller each frame (nulled on dispose). */
  effects: EffectsService | null;
  /** New shields are on this frame (the caller opened the shield frame). */
  fxShieldsOn: boolean;
  /** Set in `init` when the new effects are on. */
  fxEngines: FxEngines | null;
  fxShields: FxShields | null;
  fxShieldPose: ShieldPoseFn;
  fxNow: () => number;
  sprites: Map<string, Container>;
  artHandles: ShipArtCtx['handles'];
  swarmSpriteKinds: Map<string, number>;
  /** Shared renderer scratch (cleared here before use). */
  seenScratch: Set<string>;
  /** Track which ships currently have an active engine emitter registered
   *  with EffectsService — lets us detect transitions per frame and only
   *  call setContinuous on actual changes (setContinuous is re-entrant
   *  but the per-key check still wins on alloc-pressure). */
  activeThrustIds: Set<string>;
  activeBoostIds: Set<string>;
  /** Set of entityIds (player playerIds OR drone "swarm-N" ids) currently
   *  carrying an active shield aura. Diff'd against mirror state each
   *  frame; transitions fire setContinuous('shield', active). */
  activeShieldIds: Set<string>;
  /** Shield radius per shielded entity (hull radius + pad), set when it comes up. */
  fxShieldRadius: Map<string, number>;
  fxEnginesLastMs: number;
  /** Top speed per ship kind (normalises a drone's engine level). */
  fxTopSpeed: Map<string, number>;
  /** Per kind: seconds of path the engine ribbon spans (`shipTuning`). */
  fxTrailS: Map<string, number>;
  /** Sprite key `swarm-<eid>` → eid, parsed once per key (#14). */
  droneEidOfKey: Map<string, number>;
}

export type EngineShieldFxCtxRefs = Pick<EngineShieldFxCtx,
  'fxShieldPose' | 'fxNow' | 'sprites' | 'artHandles' | 'swarmSpriteKinds' | 'seenScratch'>;

/** Build the pooled engine / shield ctx once (renderer construction). */
export function createEngineShieldFxCtx(refs: EngineShieldFxCtxRefs): EngineShieldFxCtx {
  return {
    ...refs,
    effects: null,
    fxShieldsOn: false,
    fxEngines: null,
    fxShields: null,
    activeThrustIds: new Set(),
    activeBoostIds: new Set(),
    activeShieldIds: new Set(),
    fxShieldRadius: new Map(),
    fxEnginesLastMs: 0,
    fxTopSpeed: new Map(),
    fxTrailS: new Map(),
    droneEidOfKey: new Map(),
  };
}

/** Forget every registration (sector handoff / dispose): the next frame
 *  re-registers emitters against the fresh mirror. */
export function clearEngineShieldFxIds(ctx: EngineShieldFxCtx): void {
  ctx.activeThrustIds.clear();
  ctx.activeBoostIds.clear();
  ctx.activeShieldIds.clear();
}

export function updateEngineShieldFx(mirror: RenderMirror, ctx: EngineShieldFxCtx): void {
  drawFxEngines(mirror, ctx);
  syncEngineContinuousEffects(mirror, ctx);
}

function droneEidOf(ctx: EngineShieldFxCtx, key: string): number {
  let eid = ctx.droneEidOfKey.get(key);
  if (eid === undefined) {
    if (ctx.droneEidOfKey.size > 4096) ctx.droneEidOfKey.clear(); // bound it; rebuilt on demand
    eid = parseInt(key.slice(6), 10);
    ctx.droneEidOfKey.set(key, eid);
  }
  return eid;
}

/** New engine exhaust for every ship sprite with Machined art: players
 *  pass their thrust / boost input, drones (`swarm-*`) follow their speed.
 *  Scrap is skipped. Reads the sprite's resolved pose
 *  (one pose per frame). Ships it draws skip today's particle emitter. */
function drawFxEngines(mirror: RenderMirror, ctx: EngineShieldFxCtx): void {
  const fx = ctx.fxEngines;
  if (!fx) return;
  const now = ctx.fxNow();
  const dt = ctx.fxEnginesLastMs > 0 ? Math.min(0.1, (now - ctx.fxEnginesLastMs) / 1000) : 1 / 60;
  ctx.fxEnginesLastMs = now;
  fx.beginFrame();
  for (const [key, sp] of ctx.sprites) {
    if (!sp.visible) continue;
    const h = ctx.artHandles.get(key);
    if (!h || h.job.type !== 'ship' || !h.ship) continue;
    let thrust: -1 | 0 | 1, boost: -1 | 0 | 1;
    if (mirror.ships.has(key)) {
      // Every ship, AI-flown hulls included: their flame bits ride the
      // same snapshot carriers under their shipInstanceId (RTS Part A S2).
      thrust = mirror.thrustingShips?.has(key) ? 1 : 0;
      boost = mirror.boostingShips?.has(key) ? 1 : 0;
    } else if (key.startsWith('swarm-') && ctx.swarmSpriteKinds.get(key) === 1) {
      // Drones only. A capital wreck piece (kind 4) holds its dead ship's
      // art handle, nozzles and all, so without this gate every drifting
      // piece drew the battleship's four-flame exhaust and ribbons.
      // Thrust follows speed (no key on the wire); boost is the AI pilot's
      // real boost key from the snapshot, the same flame a pilot's gets.
      thrust = -1;
      boost = droneBoostInput(mirror.swarm?.get(droneEidOf(ctx, key)));
    } else continue;
    drawFxEngineFor(ctx, fx, key, sp, h, thrust, boost, dt, now);
  }
  fx.endFrame();
}

/** One hull's exhaust (+ GPU-lit engine lights) for `drawFxEngines`. */
function drawFxEngineFor(
  ctx: EngineShieldFxCtx,
  fx: FxEngines,
  key: string,
  sp: Container,
  h: NonNullable<ReturnType<ShipArtCtx['handles']['get']>>,
  thrust: -1 | 0 | 1,
  boost: -1 | 0 | 1,
  dt: number,
  now: number,
): void {
  if (h.job.type !== 'ship' || !h.ship) return;
  let top = ctx.fxTopSpeed.get(h.job.id), trail = ctx.fxTrailS.get(h.job.id);
  if (top === undefined || trail === undefined) {
    const k = getShipKind(h.job.id);
    top = k.maxSpeed; trail = shipTuning(k).exhaustTrailS;
    ctx.fxTopSpeed.set(h.job.id, top); ctx.fxTrailS.set(h.job.id, trail);
  }
  fx.draw(key, h.ship.nozzles, sp.x, sp.y, sp.rotation, thrust, boost, top, dt, now, trail);
  // GPU-lit art: each engine is a light in its plume (its own hull takes little).
  const ls = litPass.settings;
  if (ls && ls.engineLights && ls.pointLights > 0) {
    const owner = sp instanceof MachinedShipSprite && sp.lit.length > 0 ? sp.lit[0]!.lightOwnerId : -1;
    const th = fx.thrustOf(key), c = Math.cos(sp.rotation), s = Math.sin(sp.rotation);
    for (const nz of h.ship.nozzles) {
      const ly = nz.y + engineLightAstern(nz.r);
      litPass.scene.addLight(sp.x + nz.x * c - ly * s, sp.y + nz.x * s + ly * c, engineLightHeight(nz.r), 0xffa24a, engineLightIntensity(nz.r, th), engineLightReach(nz.r), owner);
    }
  }
}

/** Diff mirror.thrustingShips / boostingShips against our last frame's
 *  registration set; fire setContinuous(id, kind, true|false) only on
 *  transitions. Mirrors the existing thrust/boost flame ownership in
 *  spriteBuilders — those Graphics flames continue to render (they are
 *  the minimal-tier fallback); EngineEmitter ADDS particle trails. */
function syncEngineContinuousEffects(mirror: RenderMirror, ctx: EngineShieldFxCtx): void {
  if (!ctx.effects) return;
  const thrust = mirror.thrustingShips;
  const boost = mirror.boostingShips;
  // Ships drawn by the new exhaust don't also get today's particles.
  const fxe = ctx.fxEngines;

  if (thrust) {
    for (const id of thrust) {
      if (!ctx.activeThrustIds.has(id) && !fxe?.drew(id)) {
        // Per-kind nozzle offset + plume scale, computed once at
        // registration (not per frame) from the ship catalogue.
        ctx.effects.setContinuous(id, 'thrust', true, undefined, engineProfileForKind(mirror.ships.get(id)?.kind));
        ctx.activeThrustIds.add(id);
      }
    }
    for (const id of ctx.activeThrustIds) {
      if (!thrust.has(id) || fxe?.drew(id)) {
        ctx.effects.setContinuous(id, 'thrust', false);
        ctx.activeThrustIds.delete(id);
      }
    }
  } else if (ctx.activeThrustIds.size > 0) {
    for (const id of ctx.activeThrustIds) ctx.effects.setContinuous(id, 'thrust', false);
    ctx.activeThrustIds.clear();
  }

  if (boost) {
    for (const id of boost) {
      if (!ctx.activeBoostIds.has(id) && !fxe?.drew(id)) {
        ctx.effects.setContinuous(id, 'boost', true, undefined, engineProfileForKind(mirror.ships.get(id)?.kind));
        ctx.activeBoostIds.add(id);
      }
    }
    for (const id of ctx.activeBoostIds) {
      if (!boost.has(id) || fxe?.drew(id)) {
        ctx.effects.setContinuous(id, 'boost', false);
        ctx.activeBoostIds.delete(id);
      }
    }
  } else if (ctx.activeBoostIds.size > 0) {
    for (const id of ctx.activeBoostIds) ctx.effects.setContinuous(id, 'boost', false);
    ctx.activeBoostIds.clear();
  }

  // Shield aura — M8 (plan wiggly-puppy). Drive from mirror.ships's
  // shieldDown field (populated by handleShield + handleDamage) AND
  // mirror.swarm's shieldDown (decoded from the binary wire's
  // SWARM_RECORD_FLAG_SHIELD_DOWN bit). Note inversion: aura is ON
  // when shield is UP (shieldDown=false / undefined). Drones use
  // "swarm-<entityId>" id prefix to namespace with the player ids.
  syncShieldAuraEffects(mirror, ctx);
}

function syncShieldAuraEffects(mirror: RenderMirror, ctx: EngineShieldFxCtx): void {
  if (!ctx.effects) return;
  const seen = ctx.seenScratch; // already cleared at top of update()
  seen.clear();

  // Aura is ON unless shieldDown is EXPLICITLY true. Default assumption
  // is "shield up" — every fresh-spawn ship has full shield (the server
  // initialises `ship.shield = kind.shieldMax` on spawn), and the
  // client only learns `shieldDown=true` via the explicit SHIELD_BROKEN
  // event. Pre-fix the aura was gated on `shieldDown === false`
  // (explicit), so an unscathed just-spawned ship rendered no aura —
  // user perception: "I spawn in without a shield up."
  // Every ship: ACTIVE and LINGERING (R2.32: a parked hull keeps its shield
  // and shows its aura), #17.
  for (const [id, ship] of mirror.ships) {
    if (ship.shieldDown !== true) seen.add(id);
  }
  if (mirror.swarm) {
    for (const [id, sw] of mirror.swarm) {
      if (sw.shieldDown !== true && sw.kind === 1) seen.add(`swarm-${id}`);
    }
  }

  for (const id of seen) {
    if (!ctx.activeShieldIds.has(id)) {
      // The drawn bubble IS the shield collider (owner's rule 2026-11-10):
      // `shieldBubbleRadiusForEntity` = shieldVisualRadius + shipTuning pad,
      // the same ball `shipShieldColliderDesc` mounts (#15/#18). Both shield
      // visuals (the legacy ring and the new FxShields) draw at it.
      const bubble = shieldBubbleRadiusForEntity(id, mirror)
        ?? shieldBubbleRadius(getShipKind(DEFAULT_SHIP_KIND));
      ctx.effects.setContinuous(id, 'shield', true, bubble);
      ctx.activeShieldIds.add(id);
      ctx.fxShieldRadius.set(id, bubble);
    }
  }
  for (const id of ctx.activeShieldIds) {
    if (!seen.has(id)) {
      ctx.effects.setContinuous(id, 'shield', false);
      ctx.activeShieldIds.delete(id);
      ctx.fxShieldRadius.delete(id);
    }
  }
  // New shields (B5): every shield up this frame, then lay them out (a
  // shield missing this frame went down and plays its break).
  ctx.effects.setShieldAuraHidden(ctx.fxShieldsOn);
  if (ctx.fxShieldsOn) {
    for (const id of ctx.activeShieldIds) ctx.fxShields!.shield(id, ctx.fxShieldRadius.get(id) ?? 38);
    ctx.fxShields!.end(ctx.fxNow(), ctx.fxShieldPose);
  }
}
