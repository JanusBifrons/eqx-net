/**
 * Machined art — the sun for a sector.
 *
 * Each sector gets its own sun direction, derived from its key (v1: a hash,
 * so it's stable and needs no wire or catalogue change). Everything else in
 * the rig is shared, so every sector reads as the same universe.
 */
import { hashStr } from './raster.js';
import { DEFAULT_RIG, type LightRig } from './shade.js';

/** Sun azimuths stay in a band where the light comes from "above" the
 *  screen, so hulls never look lit from underneath. Radians, Pixi space. */
const AZ_MIN = (-150 / 180) * Math.PI;
const AZ_MAX = (-30 / 180) * Math.PI;

export function sunRigForSector(sectorKey: string | null): LightRig {
  if (!sectorKey) return DEFAULT_RIG;
  const u = hashStr(`sun:${sectorKey}`) / 4294967296;
  // Round to 1° so the cache key (which includes the azimuth) is stable.
  const az = Math.round(((AZ_MIN + (AZ_MAX - AZ_MIN) * u) * 180) / Math.PI) * (Math.PI / 180);
  return { ...DEFAULT_RIG, sunAz: az };
}
