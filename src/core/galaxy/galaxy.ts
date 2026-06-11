/**
 * The persistent galaxy graph (Phase 8).
 *
 * Pure module: no I/O, no imports outside the TS stdlib. Both the server
 * (room registration, neighbour validation) and the client (landing screen,
 * in-game galaxy-map overlay) consume this. To grow the galaxy, add entries
 * with valid axial-hex coords + symmetric edges and run the unit tests; the
 * tests enforce structural invariants and will catch typos.
 *
 * See docs/architecture/galaxy-graph.md for the walkthrough.
 */

/** Axial hex coordinates. q runs east, r runs south-east. (0,0) = centre. */
export interface AxialHex {
  q: number;
  r: number;
}

export type AsteroidConfigKey = 'sparse' | 'dense' | 'none';

export interface GalaxySector {
  /** Stable identity used as the persistence key. Slug-style, lowercase. */
  key: string;
  /** Display name. */
  name: string;
  /** One-line description shown on the landing screen. */
  description: string;
  /** Axial hex position used by both landing screen and in-game overlay. */
  hex: AxialHex;
  /** Adjacent sector keys. Edges must be symmetric (validated by tests). */
  neighbours: string[];
  /** Asteroid layout key — resolved server-side via asteroidConfigs.ts. */
  asteroidConfigKey: AsteroidConfigKey;
  /** Boot-seeded patrol-drone count for this galaxy sector. RETIRED to 0
   *  (drone-warp-in, 2026-06-11): drones no longer materialise in galaxy
   *  sectors at room creation — they warp in at entry (edge) sectors and the
   *  `LivingWorldDirector`'s roaming squad pool provides ALL ambient presence.
   *  Engineering/test rooms still set their own `droneCount` directly. */
  droneCount: number;
  /** Default ship spawn coords for fresh entry into this sector. */
  defaultSpawn: { x: number; y: number };
}

/**
 * Ambient patrol-drone boot-seed floor per galaxy sector. **RETIRED to 0**
 * (drone-warp-in refactor, 2026-06-11). Previously 2/sector (and 8–20 pre-Living
 * World); now NO drone is boot-seeded into a galaxy sector. All ambient presence
 * comes from the `LivingWorldDirector`'s roaming squad pool, which materialises
 * drones ONLY at entry (edge) sectors and lets them hop inward — so a drone is
 * never conjured in an interior sector out of nowhere. Kept as a named constant
 * (rather than an inline 0) so the retirement is explicit at every call site;
 * re-raising it would re-introduce magic-appearance drones and is a deliberate,
 * reviewed change.
 */
export const AMBIENT_DRONE_FLOOR = 0;

/**
 * 7-sector sunflower: 1 centre + 6 ring outers.
 *   centre (sol-prime) connects to all 6 outers.
 *   each outer connects to centre + its two ring-adjacent neighbours.
 * Axial hex coords give the 6 outers at distance 1 from the centre.
 */
export const GALAXY_SECTORS: readonly GalaxySector[] = [
  {
    key: 'sol-prime',
    name: 'Sol Prime',
    description: 'The home sector. Asteroid-rich, low drone density.',
    hex: { q: 0, r: 0 },
    neighbours: ['orion-belt', 'vega-reach', 'cygnus-arm', 'kepler-spur', 'andromeda-rim', 'lyra-fringe'],
    asteroidConfigKey: 'dense',
    droneCount: AMBIENT_DRONE_FLOOR,
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'orion-belt',
    name: 'Orion Belt',
    description: 'Sparse rocks, moderate drone patrols.',
    hex: { q: 0, r: -1 },
    neighbours: ['sol-prime', 'vega-reach', 'lyra-fringe'],
    asteroidConfigKey: 'sparse',
    droneCount: AMBIENT_DRONE_FLOOR,
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'vega-reach',
    name: 'Vega Reach',
    description: 'Trade-lane edge. Sparse cover, frequent drone sweeps.',
    hex: { q: 1, r: -1 },
    neighbours: ['sol-prime', 'orion-belt', 'cygnus-arm'],
    asteroidConfigKey: 'sparse',
    droneCount: AMBIENT_DRONE_FLOOR,
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'cygnus-arm',
    name: 'Cygnus Arm',
    description: 'Open void. No asteroids; drones own the lane.',
    hex: { q: 1, r: 0 },
    neighbours: ['sol-prime', 'vega-reach', 'kepler-spur'],
    asteroidConfigKey: 'none',
    droneCount: AMBIENT_DRONE_FLOOR,
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'kepler-spur',
    name: 'Kepler Spur',
    description: 'Sparse rocks, contested drone presence.',
    hex: { q: 0, r: 1 },
    neighbours: ['sol-prime', 'cygnus-arm', 'andromeda-rim'],
    asteroidConfigKey: 'sparse',
    droneCount: AMBIENT_DRONE_FLOOR,
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'andromeda-rim',
    name: 'Andromeda Rim',
    description: 'Dense asteroid field. Lighter drone presence.',
    hex: { q: -1, r: 1 },
    neighbours: ['sol-prime', 'kepler-spur', 'lyra-fringe'],
    asteroidConfigKey: 'dense',
    droneCount: AMBIENT_DRONE_FLOOR,
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'lyra-fringe',
    name: 'Lyra Fringe',
    description: 'Dense asteroid field. Lighter drone presence.',
    hex: { q: -1, r: 0 },
    neighbours: ['sol-prime', 'andromeda-rim', 'orion-belt'],
    asteroidConfigKey: 'dense',
    droneCount: AMBIENT_DRONE_FLOOR,
    defaultSpawn: { x: 0, y: 0 },
  },
];

export const DEFAULT_SECTOR_KEY = 'sol-prime';

/** Look up a sector by key; undefined if not in the graph. */
export function getSector(key: string): GalaxySector | undefined {
  return GALAXY_SECTORS.find((s) => s.key === key);
}

/** Resolved neighbour entries for a sector (not just keys). Empty array on unknown source. */
export function getNeighbours(key: string): GalaxySector[] {
  const src = getSector(key);
  if (!src) return [];
  const out: GalaxySector[] = [];
  for (const n of src.neighbours) {
    const sec = getSector(n);
    if (sec) out.push(sec);
  }
  return out;
}

/** True iff `toKey` is a direct neighbour of `fromKey` in the graph. */
export function isNeighbour(fromKey: string, toKey: string): boolean {
  const src = getSector(fromKey);
  return src ? src.neighbours.includes(toKey) : false;
}

/** Axial-hex distance from the centre (Sol Prime at 0,0). */
function hexDistanceFromCentre(h: AxialHex): number {
  return (Math.abs(h.q) + Math.abs(h.r) + Math.abs(h.q + h.r)) / 2;
}

/**
 * ENTRY (edge-of-galaxy) sectors — where Living World drone squads materialize
 * (warp in) before hopping INWARD toward a target base, and where a killed
 * squad respawns. Drones never appear in an interior sector out of nowhere; the
 * galaxy "edge" is the only ingress (drone-warp-in design).
 *
 * Derived as the OUTERMOST ring (sectors at the maximum hex distance from the
 * centre) rather than a hand-set per-record flag — so the set follows the graph
 * if the galaxy grows (add a second ring and the edge moves outward with no
 * bookkeeping). For the current 7-sector sunflower this is the 6 ring outers;
 * the centre (sol-prime) is never an entry sector. Locked by `galaxy.test.ts`.
 */
export function getEntrySectors(): GalaxySector[] {
  let maxD = 0;
  for (const s of GALAXY_SECTORS) maxD = Math.max(maxD, hexDistanceFromCentre(s.hex));
  // maxD === 0 would mean a single-sector galaxy (only the centre); then there
  // is no edge ring → no entry sectors (the caller falls back / no spawns).
  if (maxD === 0) return [];
  return GALAXY_SECTORS.filter((s) => hexDistanceFromCentre(s.hex) === maxD);
}

/** True iff `key` is an entry (edge) sector — see {@link getEntrySectors}. */
export function isEntrySector(key: string): boolean {
  const s = getSector(key);
  if (!s) return false;
  let maxD = 0;
  for (const g of GALAXY_SECTORS) maxD = Math.max(maxD, hexDistanceFromCentre(g.hex));
  return maxD > 0 && hexDistanceFromCentre(s.hex) === maxD;
}

/** Standard pointy-top axial→pixel projection. Used by the SVG renderer. */
export function axialToPixel(hex: AxialHex, size: number): { x: number; y: number } {
  const x = size * Math.sqrt(3) * (hex.q + hex.r / 2);
  const y = size * (3 / 2) * hex.r;
  return { x, y };
}
