import { axialToPixel, type GalaxySector } from '@core/galaxy/galaxy';

/**
 * Pure territory model for {@link GalaxyMapLayer} (Living Galaxy Phase 4a — the
 * `galaxyLayerDecisions.ts` idiom: the logic lives here + is unit-tested, the
 * Pixi calls stay in the layer).
 *
 * A **territory** is a maximal set of same-faction sectors that are CONTIGUOUS in
 * the galaxy graph (BFS over same-faction neighbours). Because the generator
 * keeps every faction graph-contiguous (a hard invariant, asserted in
 * galaxy.test.ts), each frontier faction yields exactly one territory; a
 * singleton/neutral sector is its own territory of one.
 *
 * The territory grouping is what makes the contiguous-territory hover-shrink
 * meaningful: the layer parents each territory's hexes under one sub-container at
 * the territory CENTROID, so a single `container.scale.set(s)` shrinks the whole
 * region toward its centre as one unit. The centroid here is in the SAME pixel
 * space as `axialToPixel(hex, hexSize)`, so the layer can position the container
 * at `centroid` and offset each child by `(hexPixel - centroid)`.
 */
export interface Territory {
  /** The shared faction id (a GALAXY_FACTIONS id == GalaxySector.region). */
  factionId: string;
  /** Member sector keys, in graph-discovery (BFS) order. */
  sectorKeys: string[];
  /** Pixel centroid (mean of members' `axialToPixel` positions at `hexSize`). */
  centroid: { x: number; y: number };
}

/**
 * Group `sectors` into faction-contiguous territories. Deterministic: territories
 * are discovered in `sectors` order; members in BFS order over
 * `GalaxySector.neighbours`. Every sector appears in exactly one territory.
 */
export function computeTerritories(
  sectors: readonly GalaxySector[],
  hexSize: number,
): Territory[] {
  const byKey = new Map(sectors.map((s) => [s.key, s]));
  const seen = new Set<string>();
  const out: Territory[] = [];

  for (const start of sectors) {
    if (seen.has(start.key)) continue;
    const factionId = start.region;
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
        if (n && n.region === factionId) {
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
      factionId,
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
