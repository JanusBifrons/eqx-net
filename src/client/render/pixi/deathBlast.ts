/**
 * The dying ship's own death blast, picked from its destruction profile:
 * whether the wreck break-up replaces it, and its size / smoke / vaporise
 * variant (fracture v11). Split out of `wreckArt.ts` (god-file budget).
 */
import { isShipKindId } from '../../../shared-types/shipKinds.js';
import { destructionProfileOf } from '../../../shared-types/shipScale/destructionProfile.js';
import { DESTRUCTION_PROFILES } from '../../../shared-types/shipScale/destruction.js';

/**
 * True when a dying ship's own death blast is left to the wreck break-up:
 * the room breaks capitals into wrecks (welcome `capitalWrecks`) and the
 * dying sprite is a capital. #493's hull-sized blast (radius ≈ the hull)
 * otherwise covers the whole hull exactly when it breaks (money-shot
 * review); the break-up's fireballs at the kill point replace it. With the
 * dying kind given, its destruction profile must say so too
 * (`fx.hullDeathBlastReplaced`): a sub-capital's wreck never replaces the
 * ship's normal death explosion (sub-capital break-up, slice 4).
 */
export function hullDeathBlastReplaced(capitalWrecks: boolean | undefined, dyingIsCapital: boolean, dyingKind?: string | null, vaporised = false): boolean {
  // Vaporised (fracture v11): no wreck, so no break-up to replace it.
  if (vaporised || capitalWrecks !== true || !dyingIsCapital) return false;
  return dyingKind == null || destructionProfileOf({ type: 'ship', kindId: dyingKind }).fx.hullDeathBlastReplaced;
}

/**
 * The ship's normal death explosion, scaled by its destruction profile
 * (`fx.deathBlastScale` radius, `fx.deathBlastLinger` smoke) while the room
 * breaks that profile into wrecks: a sub-capital with welcome `subcapWrecks`
 * (owner 2026-11-13, "Shrink it": ~half size, shorter smoke, so the break-up
 * and the fight stay readable and capitals feel bigger). Everything else,
 * and every death with the flag off, is 1 / 1 (unchanged).
 *
 * A `vaporised` death (fracture v11: a cut kill burned the whole hull away)
 * picks the vaporise variant instead (`vaporise`, the profile's
 * `fx.vaporiseBlastScale` / `vaporiseSeconds` / `vaporiseTint`): the server
 * only says so in a room that breaks the kind, so no flag gate. An unknown
 * kind takes the sub-cap look. Alloc-free.
 */
export interface DeathBlast {
  /** Radius multiplier on `blastRadiusFor(diameter)`. */
  scale: number;
  /** Smoke linger (normal blast only). */
  linger: number;
  /** Play the vaporise variant (`FxExplosions.spawnVaporise`). */
  vaporise: boolean;
  /** Vaporise only: the flash / glow / ash tint and the burst's length (s). */
  tint: number;
  seconds: number;
}

export function deathBlastFor(
  subcapWrecks: boolean | undefined, capitalWrecks: boolean | undefined, kind: string | null | undefined,
  out: DeathBlast, vaporised = false,
): DeathBlast {
  out.scale = 1;
  out.linger = 1;
  out.vaporise = false;
  out.tint = 0;
  out.seconds = 0;
  const known = typeof kind === 'string' && isShipKindId(kind);
  if (vaporised) {
    const fx = known ? destructionProfileOf({ type: 'ship', kindId: kind }).fx : DESTRUCTION_PROFILES.subcap.fx;
    out.vaporise = true;
    out.scale = fx.vaporiseBlastScale;
    out.tint = fx.vaporiseTint;
    out.seconds = fx.vaporiseSeconds;
    return out;
  }
  if (!known) return out;
  const p = destructionProfileOf({ type: 'ship', kindId: kind });
  const on = p.id === 'subcap' ? subcapWrecks === true : p.id === 'capital' ? capitalWrecks === true : false;
  if (!on) return out;
  out.scale = p.fx.deathBlastScale;
  out.linger = p.fx.deathBlastLinger;
  return out;
}
