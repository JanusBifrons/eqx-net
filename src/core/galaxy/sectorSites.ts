/**
 * Solar-system sectors (plan prancy-squishing-donut Phase 4): a sector spans
 * ±SOLAR_HALF_EXTENT and is mostly empty space, with a few active POCKETS a
 * few km across, 50–150 km apart. This lays them out, deterministically per
 * sector key (every server and client derives the same layout, nothing is
 * persisted):
 *
 *  - `home`  at the origin: today's whole sector (bases, belts, spawns), so
 *            saved structures keep their coordinates;
 *  - `gate`  one per neighbour, on the bearing toward it near the edge: that
 *            neighbour's alien gate, and where traffic from it arrives;
 *  - `belt`  asteroid belts (one, two with asteroid / mineral features);
 *  - `base`  an outer NPC base site;
 *  - `combat` where world events and elites play out.
 *
 * Pure (no I/O, no randomness beyond the seeded stream).
 */
import { getNeighbours, getSector, axialToPixel, type GalaxySector } from './galaxy.js';

/** Half extent of a solar-system sector (world units). */
export const SOLAR_HALF_EXTENT = 200_000;
/** Pockets sit at least this far apart, centre to centre. */
export const POCKET_MIN_GAP = 50_000;
/** Every pocket has another within this distance (no isolated outpost). */
export const POCKET_MAX_GAP = 150_000;
/** Gate pockets sit this far from the origin, toward their neighbour. */
export const GATE_POCKET_RADIUS = 170_000;

export type SiteKind = 'home' | 'gate' | 'belt' | 'base' | 'combat';

export interface SectorSite {
  /** Stable within the sector: `home`, `gate:<neighbour>`, `belt:0`, … */
  id: string;
  kind: SiteKind;
  /** Centre, game space (Y up). */
  x: number;
  y: number;
  /** Rough radius of the active area. */
  r: number;
  /** For a gate pocket: the sector it faces. */
  neighbour?: string;
}

const RADII: Record<SiteKind, number> = { home: 5000, gate: 3000, belt: 4000, base: 4000, combat: 3000 };

/** FNV-1a 32-bit hash of a string (the seed). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** mulberry32: a small deterministic PRNG in [0, 1). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bearing (rad, game space Y up) from one sector to another on the map. */
function bearingTo(from: GalaxySector, to: GalaxySector): number {
  const a = axialToPixel(from.hex, 1);
  const b = axialToPixel(to.hex, 1);
  return Math.atan2(-(b.y - a.y), b.x - a.x);
}

const angDist = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** The sector's pockets (empty for an unknown key). Same result every call. */
export function sectorSites(sectorKey: string): SectorSite[] {
  const sector = getSector(sectorKey);
  if (!sector) return [];
  const sites: SectorSite[] = [{ id: 'home', kind: 'home', x: 0, y: 0, r: RADII.home }];
  const gateBearings: number[] = [];
  for (const n of getNeighbours(sectorKey)) {
    const b = bearingTo(sector, n);
    gateBearings.push(b);
    sites.push({
      id: `gate:${n.key}`, kind: 'gate', neighbour: n.key,
      x: Math.round(Math.cos(b) * GATE_POCKET_RADIUS), y: Math.round(Math.sin(b) * GATE_POCKET_RADIUS), r: RADII.gate,
    });
  }
  const rich = sector.features.includes('asteroid') || sector.features.includes('minerals');
  const wanted: SiteKind[] = ['belt', ...(rich ? ['belt' as const] : []), 'base', 'combat'];
  const rand = rng(hash(`sites:${sectorKey}`));
  const counts: Partial<Record<SiteKind, number>> = {};
  for (const kind of wanted) {
    const r = RADII[kind];
    let placed: SectorSite | null = null;
    // Seeded tries: away from gate bearings, not on top of another pocket,
    // and within reach of one (no isolated outpost).
    for (let tryN = 0; tryN < 400 && !placed; tryN++) {
      const bearing = rand() * Math.PI * 2;
      if (gateBearings.some((g) => angDist(g, bearing) < 0.35)) continue;
      const dist = 60_000 + rand() * 80_000;
      const x = Math.round(Math.cos(bearing) * dist), y = Math.round(Math.sin(bearing) * dist);
      if (Math.abs(x) > SOLAR_HALF_EXTENT - r || Math.abs(y) > SOLAR_HALF_EXTENT - r) continue;
      let nearest = Infinity, clash = false;
      for (const s of sites) {
        const d = Math.hypot(s.x - x, s.y - y);
        if (d < POCKET_MIN_GAP) { clash = true; break; }
        nearest = Math.min(nearest, d);
      }
      if (clash || nearest > POCKET_MAX_GAP) continue;
      const i = counts[kind] ?? 0;
      counts[kind] = i + 1;
      placed = { id: `${kind}:${i}`, kind, x, y, r };
    }
    if (placed) sites.push(placed);
  }
  return sites;
}

/** The pocket of `kind` nearest (x, y), or null. */
export function nearestSite(sites: readonly SectorSite[], x: number, y: number, kind?: SiteKind): SectorSite | null {
  let best: SectorSite | null = null, bd = Infinity;
  for (const s of sites) {
    if (kind && s.kind !== kind) continue;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
