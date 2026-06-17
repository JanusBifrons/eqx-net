import { axialToPixel, type GalaxySector } from '@core/galaxy/galaxy';

/**
 * Pure territory model for {@link GalaxyMapLayer} (Living Galaxy Phase 4a — the
 * `galaxyLayerDecisions.ts` idiom: the logic lives here + is unit-tested, the
 * Pixi calls stay in the layer).
 *
 * A **territory** is a maximal set of same-OWNER sectors that are CONTIGUOUS in
 * the galaxy graph (BFS over same-owner neighbours). Ownership is resolved by the
 * injected `ownerOf` callback — the {@link import('./sectorOwnership').resolveSectorOwner}
 * seam — NOT the baked `GalaxySector.region` (Equinox Phase 9, item 1): that is
 * what makes the grouping DYNAMIC rather than hard-coded. Today every sector is
 * NEUTRAL, so the whole connected galaxy forms ONE territory; as capture/faction
 * mechanics arrive, `ownerOf` returns real owners and territories re-form here
 * with no caller change.
 *
 * The territory grouping is what makes the contiguous-territory hover-shrink
 * meaningful: the layer parents each territory's hexes under one sub-container at
 * the territory CENTROID, so a single `container.scale.set(s)` shrinks the whole
 * region toward its centre as one unit. The centroid here is in the SAME pixel
 * space as `axialToPixel(hex, hexSize)`, so the layer can position the container
 * at `centroid` and offset each child by `(hexPixel - centroid)`.
 */
export interface Territory {
  /** The shared OWNER id (a {@link import('./sectorOwnership').OwnerId} —
   *  NEUTRAL_OWNER today; a faction/player id once capture exists). */
  ownerId: string;
  /** Member sector keys, in graph-discovery (BFS) order. */
  sectorKeys: string[];
  /** Pixel centroid (mean of members' `axialToPixel` positions at `hexSize`). */
  centroid: { x: number; y: number };
}

/**
 * Group `sectors` into owner-contiguous territories. `ownerOf` resolves each
 * sector's owner (inject `resolveSectorOwner`); BFS merges contiguous neighbours
 * that share that owner. Deterministic: territories are discovered in `sectors`
 * order; members in BFS order over `GalaxySector.neighbours`. Every sector
 * appears in exactly one territory.
 */
export function computeTerritories(
  sectors: readonly GalaxySector[],
  hexSize: number,
  ownerOf: (sector: GalaxySector) => string,
): Territory[] {
  const byKey = new Map(sectors.map((s) => [s.key, s]));
  // Resolve ownership once per sector (deterministic + avoids re-calling ownerOf
  // for every neighbour visit).
  const ownerByKey = new Map<string, string>();
  for (const s of sectors) ownerByKey.set(s.key, ownerOf(s));
  const seen = new Set<string>();
  const out: Territory[] = [];

  for (const start of sectors) {
    if (seen.has(start.key)) continue;
    const ownerId = ownerByKey.get(start.key)!;
    const members: string[] = [];
    const queue: string[] = [start.key];
    seen.add(start.key);
    while (queue.length > 0) {
      const key = queue.shift()!;
      members.push(key);
      const sec = byKey.get(key);
      if (!sec) continue;
      for (const nKey of sec.neighbours) {
        if (seen.has(nKey)) continue;
        const n = byKey.get(nKey);
        if (n && ownerByKey.get(nKey) === ownerId) {
          seen.add(nKey);
          queue.push(nKey);
        }
      }
    }

    let sumX = 0;
    let sumY = 0;
    for (const key of members) {
      const p = axialToPixel(byKey.get(key)!.hex, hexSize);
      sumX += p.x;
      sumY += p.y;
    }
    out.push({
      ownerId,
      sectorKeys: members,
      centroid: { x: sumX / members.length, y: sumY / members.length },
    });
  }
  return out;
}

/**
 * Faction → territory-tint colour (client render concern; core
 * `GALAXY_FACTIONS` stays UI-free with only display names). Drawn at low alpha as
 * the hex fill; the current-sector pulse + selectable strokes layer on top.
 * Unknown faction ⇒ a neutral grey so a new region is never invisible.
 */
const FACTION_COLORS: Readonly<Record<string, number>> = {
  core: 0x3d6fb4, // steel blue — the safe home core
  'verdant-reach': 0x2f9e54, // green — growth country
  'crimson-expanse': 0xc0392b, // red — ember void
  'azure-deep': 0x1f9e9e, // teal — the cold deep
};

export const DEFAULT_FACTION_COLOR = 0x8893a6;

export function factionColor(factionId: string): number {
  return FACTION_COLORS[factionId] ?? DEFAULT_FACTION_COLOR;
}

/**
 * Faction → BORDER colour — a brighter / more saturated sibling of the fill,
 * used for the bold outer-territory outline (the eqx-peri "territory outline,
 * not per-cell grid" look). Brighter than {@link factionColor} so the perimeter
 * reads over the muted fill.
 */
const FACTION_BORDER_COLORS: Readonly<Record<string, number>> = {
  core: 0x6ea0e8,
  'verdant-reach': 0x4fdc7a,
  'crimson-expanse': 0xff6b5e,
  'azure-deep': 0x3fd6d6,
};

export const DEFAULT_FACTION_BORDER_COLOR = 0xb8c2d6;

export function factionBorderColor(factionId: string): number {
  return FACTION_BORDER_COLORS[factionId] ?? DEFAULT_FACTION_BORDER_COLOR;
}

/**
 * Axial neighbour offset across hex-edge `ei`, where edge `ei` runs from
 * `GalaxyMapLayer.hexVertices` vertex `ei` → vertex `(ei+1) % 6` (vertex angles
 * 30°, 90°, 150°, 210°, 270°, 330°). The neighbour across an edge sits in the
 * edge's outward-normal direction. **MUST stay in sync with `hexVertices`** —
 * locked by galaxyTerritories.test.ts against the live vertex order + the core
 * `axialToPixel` projection (the highest-risk detail of the border port).
 */
export const HEX_EDGE_NEIGHBOUR_DIRS: ReadonlyArray<{ q: number; r: number }> = [
  { q: 0, r: 1 }, // edge 0 (30°→90°): lower-right
  { q: -1, r: 1 }, // edge 1 (90°→150°): lower-left
  { q: -1, r: 0 }, // edge 2 (150°→210°): left
  { q: 0, r: -1 }, // edge 3 (210°→270°): upper-left
  { q: 1, r: -1 }, // edge 4 (270°→330°): upper-right
  { q: 1, r: 0 }, // edge 5 (330°→30°): right
];

/**
 * The hex-edge indices of `sector` that lie on its faction's OUTER perimeter —
 * i.e. the hex across that edge is absent or a DIFFERENT faction. Drawing only
 * these (in the faction border colour) yields one continuous outline per
 * contiguous territory; shared interior edges are suppressed on both sides.
 * `factionAt(q, r)` returns the faction id at a hex position, or null.
 */
export function boundaryEdges(
  sector: { hex: { q: number; r: number }; region: string },
  factionAt: (q: number, r: number) => string | null,
): number[] {
  const out: number[] = [];
  for (let ei = 0; ei < HEX_EDGE_NEIGHBOUR_DIRS.length; ei++) {
    const d = HEX_EDGE_NEIGHBOUR_DIRS[ei]!;
    if (factionAt(sector.hex.q + d.q, sector.hex.r + d.r) !== sector.region) out.push(ei);
  }
  return out;
}
