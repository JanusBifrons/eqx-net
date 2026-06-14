/**
 * The persistent galaxy graph (Living Galaxy — Phase 1).
 *
 * ░░ THE SECTOR / FACTION / ENTRY DATA BELOW IS GENERATED ░░
 * Source of truth: scripts/generate-galaxy.ts. To grow or reshape the galaxy,
 * edit the spec there and run:
 *
 *   pnpm tsx scripts/generate-galaxy.ts > src/core/galaxy/galaxy.ts
 *
 * The generator validates every structural invariant (symmetric edges, no
 * dangling neighbours, connected graph, contiguous factions, exactly one
 * chokepoint per frontier region, >=1 entry sector per region) at bake time;
 * galaxy.test.ts re-locks them. Do NOT hand-edit the GALAXY_SECTORS /
 * GALAXY_FACTIONS / ENTRY_SECTOR_KEYS literals — your edit will be lost on the
 * next regen. Hand-edit the types + helper functions freely (they are stable).
 *
 * Pure module: no I/O, no imports outside the TS stdlib. Both the server (room
 * registration, neighbour validation) and the client (galaxy map) consume this.
 *
 * Topology: a home CORE (Sol Dominion) + 3 frontier regions (Verdant Reach,
 * Crimson Expanse, Azure Deep), each reachable from the core ONLY through a
 * single chokepoint gateway. See docs/architecture/galaxy-graph.md.
 */

/** Axial hex coordinates. q runs east, r runs south-east. (0,0) = centre. */
export interface AxialHex {
  q: number;
  r: number;
}

export type AsteroidConfigKey = 'sparse' | 'dense' | 'none';

/**
 * Static, cosmetic environmental-feature glyphs shown per sector on the map
 * (eqx-peri icon vocabulary). Baked from region theme + asteroid config; NOT
 * live state (live counts ride the Phase-3 /galaxy/snapshot endpoint).
 */
export type SectorFeature = 'asteroid' | 'nebula' | 'minerals' | 'blackhole' | 'station';

export interface GalaxySector {
  /** Stable identity used as the persistence key. Slug-style, lowercase. */
  key: string;
  /** Display name. */
  name: string;
  /** One-line description shown on the landing screen. */
  description: string;
  /**
   * Region / faction id this sector belongs to (a {@link GALAXY_FACTIONS} id).
   * COSMETIC + STATIC in v1 — the per-region territory tint + the contiguous
   * hover-shrink (P4) key off it. Every sector of a frontier region shares one
   * faction and the region is graph-contiguous by construction (a hard generator
   * invariant), so a BFS over same-faction neighbours yields the whole territory.
   * FUTURE: derive real ownership from the StructureRegistry (dominant Capital
   * holder); the id is the stable seam across cosmetic → derived → named-faction
   * → conquest. See docs/architecture/living-galaxy.md.
   */
  region: string;
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
  /** Static cosmetic feature glyphs for the map (see {@link SectorFeature}). */
  features: SectorFeature[];
  /** Default ship spawn coords for fresh entry into this sector. */
  defaultSpawn: { x: number; y: number };
}

/** A galaxy faction / region. COSMETIC v1 — `displayName` is the only rendered
 *  field; ownership/contest derivation is future work (see {@link GalaxySector.region}). */
export interface GalaxyFaction {
  id: string;
  displayName: string;
}

/**
 * Ambient patrol-drone boot-seed floor per galaxy sector. **RETIRED to 0**
 * (drone-warp-in refactor, 2026-06-11). All ambient presence comes from the
 * `LivingWorldDirector`'s roaming squad pool, which materialises drones ONLY at
 * entry (edge) sectors and lets them hop inward — so a drone is never conjured
 * in an interior sector out of nowhere. Kept as a named constant (rather than an
 * inline 0) so the retirement is explicit at every call site.
 */
export const AMBIENT_DRONE_FLOOR = 0;

/** The galaxy factions / regions (cosmetic v1). GENERATED — see file header. */
export const GALAXY_FACTIONS: readonly GalaxyFaction[] = [
  { id: 'core', displayName: 'Sol Dominion' },
  { id: 'verdant-reach', displayName: 'Verdant Reach' },
  { id: 'crimson-expanse', displayName: 'Crimson Expanse' },
  { id: 'azure-deep', displayName: 'Azure Deep' },
];

/**
 * The galaxy: a home core + 3 chokepoint-gated frontier regions (21 sectors).
 * GENERATED — see file header. Do not hand-edit.
 */
export const GALAXY_SECTORS: readonly GalaxySector[] = [
  {
    key: 'sol-prime',
    name: 'Sol Prime',
    description: 'The home sector — fortified and asteroid-rich, the safest harbour in known space.',
    region: 'core',
    hex: { q: 0, r: 0 },
    neighbours: ['vega-reach', 'lyra-fringe', 'cygnus-arm'],
    asteroidConfigKey: 'dense',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['station', 'asteroid'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'vega-reach',
    name: 'Vega Reach',
    description: 'Core trade junction and the gateway road to the Verdant Reach.',
    region: 'core',
    hex: { q: 1, r: 0 },
    neighbours: ['sol-prime', 'lyra-fringe', 'orion-belt'],
    asteroidConfigKey: 'sparse',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['station'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'lyra-fringe',
    name: 'Lyra Fringe',
    description: 'Core\'s southern marches, where the long descent toward the Azure Deep begins.',
    region: 'core',
    hex: { q: 0, r: 1 },
    neighbours: ['sol-prime', 'vega-reach', 'kepler-spur'],
    asteroidConfigKey: 'dense',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['asteroid', 'minerals'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'orion-belt',
    name: 'Orion Belt',
    description: 'The Verdant gateway — a dense belt funnelling all traffic into the Reach.',
    region: 'verdant-reach',
    hex: { q: 2, r: -1 },
    neighbours: ['vega-reach', 'thornfield', 'bloomgate'],
    asteroidConfigKey: 'dense',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['asteroid'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'thornfield',
    name: 'Thornfield',
    description: 'Tangled debris fields, thick with ore for the taking.',
    region: 'verdant-reach',
    hex: { q: 2, r: -2 },
    neighbours: ['orion-belt', 'bloomgate', 'verdance'],
    asteroidConfigKey: 'dense',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['asteroid', 'minerals'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'bloomgate',
    name: 'Bloomgate',
    description: 'A bright nebular bloom marks the heart of the Reach.',
    region: 'verdant-reach',
    hex: { q: 3, r: -2 },
    neighbours: ['orion-belt', 'thornfield', 'verdance', 'emerald-span'],
    asteroidConfigKey: 'sparse',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['nebula', 'minerals'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'verdance',
    name: 'Verdance',
    description: 'Mineral-thick drifts — prime mining country.',
    region: 'verdant-reach',
    hex: { q: 3, r: -3 },
    neighbours: ['thornfield', 'bloomgate', 'emerald-span', 'greenfall'],
    asteroidConfigKey: 'dense',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['minerals', 'asteroid'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'emerald-span',
    name: 'Emerald Span',
    description: 'Open span along the Reach\'s outer arc.',
    region: 'verdant-reach',
    hex: { q: 4, r: -3 },
    neighbours: ['bloomgate', 'verdance', 'greenfall'],
    asteroidConfigKey: 'sparse',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['asteroid'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'greenfall',
    name: 'Greenfall',
    description: 'The Reach\'s frontier edge — drones cross in from the dark beyond.',
    region: 'verdant-reach',
    hex: { q: 4, r: -4 },
    neighbours: ['verdance', 'emerald-span'],
    asteroidConfigKey: 'sparse',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['blackhole'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'cygnus-arm',
    name: 'Cygnus Arm',
    description: 'The Crimson gateway — an open arm guarding the road into the Expanse.',
    region: 'crimson-expanse',
    hex: { q: -1, r: 0 },
    neighbours: ['sol-prime', 'andromeda-rim', 'emberwake'],
    asteroidConfigKey: 'none',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['nebula'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'andromeda-rim',
    name: 'Andromeda Rim',
    description: 'A glowing rim of ember-lit gas at the edge of the Expanse.',
    region: 'crimson-expanse',
    hex: { q: -2, r: 0 },
    neighbours: ['cygnus-arm', 'emberwake', 'cinderpath', 'scoria-drift'],
    asteroidConfigKey: 'sparse',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['nebula'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'emberwake',
    name: 'Emberwake',
    description: 'Stellar embers drift through a thin, smouldering field.',
    region: 'crimson-expanse',
    hex: { q: -2, r: 1 },
    neighbours: ['cygnus-arm', 'andromeda-rim', 'cinderpath'],
    asteroidConfigKey: 'sparse',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['nebula', 'asteroid'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'cinderpath',
    name: 'Cinderpath',
    description: 'A scorched lane threading between dying stars.',
    region: 'crimson-expanse',
    hex: { q: -3, r: 1 },
    neighbours: ['andromeda-rim', 'emberwake', 'scoria-drift', 'ashfront'],
    asteroidConfigKey: 'none',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['blackhole'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'scoria-drift',
    name: 'Scoria Drift',
    description: 'Slag and shattered rock tumble through the dark.',
    region: 'crimson-expanse',
    hex: { q: -3, r: 0 },
    neighbours: ['andromeda-rim', 'cinderpath', 'ashfront'],
    asteroidConfigKey: 'dense',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['asteroid'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'ashfront',
    name: 'Ashfront',
    description: 'The Expanse\'s burning frontier — raiders gather here.',
    region: 'crimson-expanse',
    hex: { q: -4, r: 1 },
    neighbours: ['cinderpath', 'scoria-drift'],
    asteroidConfigKey: 'none',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['blackhole', 'nebula'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'kepler-spur',
    name: 'Kepler Spur',
    description: 'The Azure gateway — a narrow spur leading into the deep.',
    region: 'azure-deep',
    hex: { q: 0, r: 2 },
    neighbours: ['lyra-fringe', 'tideglass', 'coralward'],
    asteroidConfigKey: 'sparse',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['asteroid'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'tideglass',
    name: 'Tideglass',
    description: 'Glassy ice shards catch the last of the distant light.',
    region: 'azure-deep',
    hex: { q: -1, r: 3 },
    neighbours: ['kepler-spur', 'coralward', 'deepcurrent'],
    asteroidConfigKey: 'sparse',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['asteroid'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'coralward',
    name: 'Coralward',
    description: 'Branching mineral reefs spread through the void.',
    region: 'azure-deep',
    hex: { q: 0, r: 3 },
    neighbours: ['kepler-spur', 'tideglass', 'deepcurrent', 'marrow-trench'],
    asteroidConfigKey: 'dense',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['minerals', 'asteroid'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'deepcurrent',
    name: 'Deepcurrent',
    description: 'Cold currents of dust pull everything toward the trench.',
    region: 'azure-deep',
    hex: { q: -1, r: 4 },
    neighbours: ['tideglass', 'coralward', 'marrow-trench', 'abyssal-gate'],
    asteroidConfigKey: 'sparse',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['nebula'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'marrow-trench',
    name: 'Marrow Trench',
    description: 'A mineral-rich trench plunging into blackness.',
    region: 'azure-deep',
    hex: { q: 0, r: 4 },
    neighbours: ['coralward', 'deepcurrent', 'abyssal-gate'],
    asteroidConfigKey: 'dense',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['minerals'],
    defaultSpawn: { x: 0, y: 0 },
  },
  {
    key: 'abyssal-gate',
    name: 'Abyssal Gate',
    description: 'The Deep\'s frontier mouth — the abyss disgorges its hunters here.',
    region: 'azure-deep',
    hex: { q: -1, r: 5 },
    neighbours: ['deepcurrent', 'marrow-trench'],
    asteroidConfigKey: 'none',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ['blackhole'],
    defaultSpawn: { x: 0, y: 0 },
  },
];

/**
 * ENTRY (edge-of-galaxy) sectors — where Living World drone squads materialise
 * (warp in) before hopping INWARD toward a target base, and where a killed squad
 * respawns. BAKED explicitly (was max-hex-distance-derived in the sunflower era):
 * with a multi-region shape the regions sit at different hex distances, so a
 * max-distance rule would pick only the single farthest region's edge. The
 * generator marks each frontier region's frontier-most sector(s); >=1 per region,
 * never the core. GENERATED — see file header. Locked by galaxy.test.ts.
 */
export const ENTRY_SECTOR_KEYS: ReadonlySet<string> = new Set([
  'greenfall',
  'ashfront',
  'abyssal-gate',
]);

export const DEFAULT_SECTOR_KEY = 'sol-prime';

/** Look up a sector by key; undefined if not in the graph. */
export function getSector(key: string): GalaxySector | undefined {
  return GALAXY_SECTORS.find((s) => s.key === key);
}

/** Look up a faction/region by id; undefined if unknown. */
export function getFaction(id: string): GalaxyFaction | undefined {
  return GALAXY_FACTIONS.find((f) => f.id === id);
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

/**
 * ENTRY (edge-of-galaxy) sectors — see {@link ENTRY_SECTOR_KEYS}. Signature kept
 * stable across the sunflower→multi-region migration so population.ts + the
 * director are untouched.
 */
export function getEntrySectors(): GalaxySector[] {
  return GALAXY_SECTORS.filter((s) => ENTRY_SECTOR_KEYS.has(s.key));
}

/** True iff `key` is an entry (edge) sector — see {@link getEntrySectors}. */
export function isEntrySector(key: string): boolean {
  return ENTRY_SECTOR_KEYS.has(key);
}

/** Standard pointy-top axial→pixel projection. Used by the map renderer. */
export function axialToPixel(hex: AxialHex, size: number): { x: number; y: number } {
  const x = size * Math.sqrt(3) * (hex.q + hex.r / 2);
  const y = size * (3 / 2) * hex.r;
  return { x, y };
}
