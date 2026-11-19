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
import { getNeighbours, getSector, axialToPixel, GALAXY_FACTIONS, type GalaxySector } from './galaxy.js';
import { SOLAR_SECTOR_HALF_EXTENT } from '../../shared-types/sectorBounds.js';
import { cutFieldPad, SLICED, type FieldClearing } from '../terrain/fieldLayout.js';

/** Half extent of a solar-system sector (world units). */
export const SOLAR_HALF_EXTENT = SOLAR_SECTOR_HALF_EXTENT;
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

/**
 * Transit pads (wrap-up plan W1b): the share of systems that get a pair. The
 * user wants them "a bit more rare" than warp (2026-11-08): instant and safe
 * for starters, so not in every system.
 */
export const POCKET_PAD_CHANCE = 0.5;

/** Who owns the transit pads: the Traders (neutral to everyone; NPC-owned,
 *  so never saved). */
export const POCKET_PAD_OWNER = 'npc:traders:pads';

export interface PocketPadPair {
  /** Home, and the one other pocket it links to. */
  a: SectorSite;
  b: SectorSite;
  /** Ideal pad centres: inside each pocket, toward the other. */
  ax: number; ay: number; bx: number; by: number;
}

/**
 * The system's transit-pad pair, or null (most systems' odds: see
 * POCKET_PAD_CHANCE). At most one pair, always from home to one belt, base or
 * battle zone. Deterministic per sector key, like the pockets themselves.
 */
export function pocketPadPair(sectorKey: string): PocketPadPair | null {
  const sites = sectorSites(sectorKey);
  const home = sites.find((s) => s.kind === 'home');
  const others = sites.filter((s) => s.kind === 'belt' || s.kind === 'base' || s.kind === 'combat');
  if (!home || others.length === 0) return null;
  const rand = rng(hash(`pads:${sectorKey}`));
  if (rand() >= POCKET_PAD_CHANCE) return null;
  const b = others[Math.floor(rand() * others.length)]!;
  const dx = b.x - home.x, dy = b.y - home.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
  return {
    a: home, b,
    ax: Math.round(home.x + ux * home.r * 0.7), ay: Math.round(home.y + uy * home.r * 0.7),
    bx: Math.round(b.x - ux * b.r * 0.7), by: Math.round(b.y - uy * b.r * 0.7),
  };
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

/**
 * Where a kind of activity centres in `sectorKey`: the pocket's centre when
 * solar-system sectors are on (`enabled`), else the sector origin (today).
 * Events and elites use the combat pocket; the first pocket of the kind wins.
 */
export function pocketCentre(sectorKey: string, kind: SiteKind, enabled: boolean): { x: number; y: number } {
  if (!enabled) return { x: 0, y: 0 };
  const s = sectorSites(sectorKey).find((p) => p.kind === kind);
  return s ? { x: s.x, y: s.y } : { x: 0, y: 0 };
}

/** How far off a pocket's rim a warp drop point may be (u). */
export const WARP_DROP_TOLERANCE = 400;

/**
 * Warp-to (Phase 4): the drop point for warping from (x, y) to `site`: its
 * rim on the side facing the ship ("the arrival point is just sensibly
 * calculated", user 2026-11-07). Computed by the client; the server only
 * checks it with `isWarpDropPoint`.
 */
export function warpDropPoint(site: SectorSite, x: number, y: number): { x: number; y: number } {
  const dx = x - site.x, dy = y - site.y, len = Math.hypot(dx, dy) || 1;
  return { x: Math.round(site.x + (dx / len) * site.r), y: Math.round(site.y + (dy / len) * site.r) };
}

/** True when (x, y) lies on some pocket's rim in `sectorKey` (within
 *  WARP_DROP_TOLERANCE) and solar-system sectors are on. */
export function isWarpDropPoint(sectorKey: string, x: number, y: number, enabled: boolean): boolean {
  if (!enabled) return false;
  for (const s of sectorSites(sectorKey)) {
    if (Math.abs(Math.hypot(x - s.x, y - s.y) - s.r) <= WARP_DROP_TOLERANCE) return true;
  }
  return false;
}

/** Rock-free room round a base or battle pocket inside a cut field, beyond
 *  its rim (u): room for the base's outer structures. */
export const FIELD_CLEARING_MARGIN = 2500;

/** Rock-free room round a belt pocket beyond its rim (u). Clearings are
 *  exact (`slicedField`), so a warp drop on the rim (site.r) lands this far
 *  from the rock wall: in open space and in view of the rocks on a phone
 *  (owner 2026-11-17: arrive at the edge and look in at the rock wall). */
export const BELT_CLEARING_MARGIN = 900;

/** A pocket's clearing radius inside a cut field. */
export function fieldClearingRadius(site: Pick<SectorSite, 'kind' | 'r'>): number {
  return site.r + (site.kind === 'belt' ? BELT_CLEARING_MARGIN : FIELD_CLEARING_MARGIN);
}

/** Bumped when the field a sector derives changes (clearings, seed rule):
 *  the seed carries it, so rock changes saved under the old field (C4,
 *  keyed `<sectorKey>|<seed>`) are never applied to different rocks. */
export const SECTOR_FIELD_VERSION = 2;

export interface SectorCutField {
  /** The field's seed (the welcome's `cutField.seed`). */
  seed: string;
  /** Every pocket the field would cover, kept open (F4). */
  clearings: FieldClearing[];
}

/**
 * Macro terrain F4: the cut field of a sector the galaxy map marks
 * `asteroid`, or null. Owner 2026-11-17: ONE field per such sector, as built
 * (300 km across, centred on home, which sits in its open core); every other
 * pocket inside it (belts, base, battle zone) is a clearing. Pure and
 * deterministic per sector key, like the pockets. Off with solar-system
 * sectors off (a ±5 km sector sits inside the open core).
 */
export function sectorCutField(sectorKey: string, enabled: boolean): SectorCutField | null {
  if (!enabled) return null;
  const sector = getSector(sectorKey);
  if (!sector || !sector.features.includes('asteroid')) return null;
  const reach = SLICED.radius + cutFieldPad();
  const clearings: FieldClearing[] = [];
  for (const site of sectorSites(sectorKey)) {
    const r = fieldClearingRadius(site);
    if (Math.hypot(site.x, site.y) - r < reach) clearings.push({ x: site.x, y: site.y, r });
  }
  return { seed: `galaxy:${sectorKey}:v${SECTOR_FIELD_VERSION}`, clearings };
}

export interface SectorWreckField {
  /** The layout seed (`wreckField` hashes `wrecks:<seed>`): the sector key. */
  seed: string;
  /** Centre: the sector's battle pocket (an old battlefield). */
  x: number;
  y: number;
  /** The two sides that fought here (faction ids: region powers). */
  sides: readonly [string, string];
  /** Every pocket kept open (the battle pocket too: hulls ring it). */
  clearings: FieldClearing[];
}

/**
 * Wreck fields F3 (slice 8): the old battlefield of a sector the galaxy map
 * marks `wrecks`, or null. Owner 2026-11-17: a few, mid-size, anywhere, may
 * share the sector with a rock field (the room's rock blocker keeps hulls off
 * the rocks). Centred on the battle pocket, which stays open with every other
 * pocket. Sides: the sector's own region against the most common other
 * region among its neighbours, else a seeded rival power. Pure and
 * deterministic per sector key. Off with solar-system sectors off.
 */
export function sectorWreckField(sectorKey: string, enabled: boolean): SectorWreckField | null {
  if (!enabled) return null;
  const sector = getSector(sectorKey);
  if (!sector || !sector.features.includes('wrecks')) return null;
  const sites = sectorSites(sectorKey);
  const centre = sites.find((s) => s.kind === 'combat') ?? sites.find((s) => s.kind === 'base');
  if (!centre) return null;
  return {
    seed: sectorKey, x: centre.x, y: centre.y, sides: [sector.region, wreckRival(sector)],
    clearings: sites.map((s) => ({ x: s.x, y: s.y, r: fieldClearingRadius(s) })),
  };
}

/** The other side of a sector's old battle (see `sectorWreckField`). Ties
 *  between neighbour regions and the no-neighbour case are seeded. */
function wreckRival(sector: GalaxySector): string {
  const rand = rng(hash(`wrecks:rival:${sector.key}`));
  const count = new Map<string, number>();
  for (const n of getNeighbours(sector.key)) if (n.region !== sector.region) count.set(n.region, (count.get(n.region) ?? 0) + 1);
  let best: string[] = [], most = 0;
  for (const [region, c] of count) {
    if (c > most) { best = [region]; most = c; } else if (c === most) best.push(region);
  }
  if (best.length === 0) best = GALAXY_FACTIONS.map((f) => f.id).filter((id) => id !== sector.region);
  return best[Math.floor(rand() * best.length)] ?? sector.region;
}
