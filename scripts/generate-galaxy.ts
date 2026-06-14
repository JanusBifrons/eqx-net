/**
 * Galaxy generator (Living Galaxy — Phase 1).
 *
 * Deterministic, reproducible dev tool. Encodes the galaxy DESIGN (a home core
 * + 3 chokepoint-gated frontier regions) as declarative data, derives the
 * symmetric edge set from hex-adjacency + the explicit chokepoint/cross-link
 * wiring, VALIDATES every structural invariant (so a coordinate slip fails here,
 * not silently in prod), and EMITS the baked `src/core/galaxy/galaxy.ts`.
 *
 * Run:  pnpm tsx scripts/generate-galaxy.ts > src/core/galaxy/galaxy.ts
 *
 * Why a builder, not RNG frontier-expansion: the eqx-net sectors are heavyweight
 * Colyseus rooms (one room per sector), and the chokepoint topology is
 * gameplay-load-bearing (a wave must funnel through a gateway). So placement is
 * deterministic-by-construction and adjacency is controlled, NOT emergent — the
 * "seed" is the design itself (a fixed design is maximally reproducible). The
 * organic-growth idea from the sibling eqx-peri cosmetic generator is adapted as
 * per-region contiguous clusters; reshuffling the galaxy = edit the spec + re-run.
 *
 * To grow/reshape the galaxy: edit SECTOR_SPECS / REGIONS / CHOKEPOINTS / CROSS_LINKS
 * below, re-run, and paste. The unit test `galaxy.test.ts` locks the invariants.
 */

// ---------------------------------------------------------------------------
// Hex math (axial; q east, r south-east; (0,0) = centre). Mirrors galaxy.ts.
// ---------------------------------------------------------------------------
interface Hex {
  q: number;
  r: number;
}

const HEX_DIRS: readonly Hex[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

function hexDistance(a: Hex, b: Hex): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
}

// ---------------------------------------------------------------------------
// Design input — the galaxy spec.
// ---------------------------------------------------------------------------
type AsteroidConfigKey = 'sparse' | 'dense' | 'none';
type SectorFeature = 'asteroid' | 'nebula' | 'minerals' | 'blackhole' | 'station';

interface SectorSpec {
  key: string;
  name: string;
  description: string;
  /** Region id (== faction id). */
  region: string;
  hex: Hex;
  asteroidConfigKey: AsteroidConfigKey;
  features: SectorFeature[];
  /** Frontier-most sector(s) of a region — drone squads warp in here. */
  isEntry?: boolean;
}

interface RegionDef {
  id: string;
  /** Player-facing faction name (cosmetic v1; capable of real ownership later). */
  displayName: string;
}

const REGIONS: readonly RegionDef[] = [
  { id: 'core', displayName: 'Sol Dominion' },
  { id: 'verdant-reach', displayName: 'Verdant Reach' },
  { id: 'crimson-expanse', displayName: 'Crimson Expanse' },
  { id: 'azure-deep', displayName: 'Azure Deep' },
];

/**
 * Explicit cross-region edges. EVERY edge between two different regions (incl.
 * core↔region) must be listed here — the validator asserts no *undeclared*
 * cross-region hex-adjacency exists, so regions connect ONLY through gateways.
 * `kind: 'chokepoint'` marks the single core↔region gateway per frontier region.
 */
const CHOKEPOINTS: ReadonlyArray<[string, string]> = [
  ['vega-reach', 'orion-belt'], // core → Verdant Reach
  ['sol-prime', 'cygnus-arm'], // core → Crimson Expanse
  ['lyra-fringe', 'kepler-spur'], // core → Azure Deep
];

/** Optional back-route links between adjacent frontier regions. None in v1
 *  (pure hub-and-spoke); add here (with the two endpoints placed hex-adjacent)
 *  for interesting back-routes — the validator will then accept that pair. */
const CROSS_LINKS: ReadonlyArray<[string, string]> = [];

const SECTOR_SPECS: readonly SectorSpec[] = [
  // ---- Core (home) — Sol Dominion. Safe hub; lowest drone presence. --------
  {
    key: 'sol-prime',
    name: 'Sol Prime',
    description: 'The home sector — fortified and asteroid-rich, the safest harbour in known space.',
    region: 'core',
    hex: { q: 0, r: 0 },
    asteroidConfigKey: 'dense',
    features: ['station', 'asteroid'],
  },
  {
    key: 'vega-reach',
    name: 'Vega Reach',
    description: 'Core trade junction and the gateway road to the Verdant Reach.',
    region: 'core',
    hex: { q: 1, r: 0 },
    asteroidConfigKey: 'sparse',
    features: ['station'],
  },
  {
    key: 'lyra-fringe',
    name: 'Lyra Fringe',
    description: "Core's southern marches, where the long descent toward the Azure Deep begins.",
    region: 'core',
    hex: { q: 0, r: 1 },
    asteroidConfigKey: 'dense',
    features: ['asteroid', 'minerals'],
  },

  // ---- Verdant Reach (NE arm) — asteroid-rich growth country. --------------
  {
    key: 'orion-belt',
    name: 'Orion Belt',
    description: 'The Verdant gateway — a dense belt funnelling all traffic into the Reach.',
    region: 'verdant-reach',
    hex: { q: 2, r: -1 },
    asteroidConfigKey: 'dense',
    features: ['asteroid'],
  },
  {
    key: 'thornfield',
    name: 'Thornfield',
    description: 'Tangled debris fields, thick with ore for the taking.',
    region: 'verdant-reach',
    hex: { q: 2, r: -2 },
    asteroidConfigKey: 'dense',
    features: ['asteroid', 'minerals'],
  },
  {
    key: 'bloomgate',
    name: 'Bloomgate',
    description: 'A bright nebular bloom marks the heart of the Reach.',
    region: 'verdant-reach',
    hex: { q: 3, r: -2 },
    asteroidConfigKey: 'sparse',
    features: ['nebula', 'minerals'],
  },
  {
    key: 'verdance',
    name: 'Verdance',
    description: 'Mineral-thick drifts — prime mining country.',
    region: 'verdant-reach',
    hex: { q: 3, r: -3 },
    asteroidConfigKey: 'dense',
    features: ['minerals', 'asteroid'],
  },
  {
    key: 'emerald-span',
    name: 'Emerald Span',
    description: "Open span along the Reach's outer arc.",
    region: 'verdant-reach',
    hex: { q: 4, r: -3 },
    asteroidConfigKey: 'sparse',
    features: ['asteroid'],
  },
  {
    key: 'greenfall',
    name: 'Greenfall',
    description: "The Reach's frontier edge — drones cross in from the dark beyond.",
    region: 'verdant-reach',
    hex: { q: 4, r: -4 },
    asteroidConfigKey: 'sparse',
    features: ['blackhole'],
    isEntry: true,
  },

  // ---- Crimson Expanse (W arm) — ember-lit open void, dangerous. -----------
  {
    key: 'cygnus-arm',
    name: 'Cygnus Arm',
    description: 'The Crimson gateway — an open arm guarding the road into the Expanse.',
    region: 'crimson-expanse',
    hex: { q: -1, r: 0 },
    asteroidConfigKey: 'none',
    features: ['nebula'],
  },
  {
    key: 'andromeda-rim',
    name: 'Andromeda Rim',
    description: 'A glowing rim of ember-lit gas at the edge of the Expanse.',
    region: 'crimson-expanse',
    hex: { q: -2, r: 0 },
    asteroidConfigKey: 'sparse',
    features: ['nebula'],
  },
  {
    key: 'emberwake',
    name: 'Emberwake',
    description: 'Stellar embers drift through a thin, smouldering field.',
    region: 'crimson-expanse',
    hex: { q: -2, r: 1 },
    asteroidConfigKey: 'sparse',
    features: ['nebula', 'asteroid'],
  },
  {
    key: 'cinderpath',
    name: 'Cinderpath',
    description: 'A scorched lane threading between dying stars.',
    region: 'crimson-expanse',
    hex: { q: -3, r: 1 },
    asteroidConfigKey: 'none',
    features: ['blackhole'],
  },
  {
    key: 'scoria-drift',
    name: 'Scoria Drift',
    description: 'Slag and shattered rock tumble through the dark.',
    region: 'crimson-expanse',
    hex: { q: -3, r: 0 },
    asteroidConfigKey: 'dense',
    features: ['asteroid'],
  },
  {
    key: 'ashfront',
    name: 'Ashfront',
    description: "The Expanse's burning frontier — raiders gather here.",
    region: 'crimson-expanse',
    hex: { q: -4, r: 1 },
    asteroidConfigKey: 'none',
    features: ['blackhole', 'nebula'],
    isEntry: true,
  },

  // ---- Azure Deep (S arm) — cold trench plunging into the abyss. -----------
  {
    key: 'kepler-spur',
    name: 'Kepler Spur',
    description: 'The Azure gateway — a narrow spur leading into the deep.',
    region: 'azure-deep',
    hex: { q: 0, r: 2 },
    asteroidConfigKey: 'sparse',
    features: ['asteroid'],
  },
  {
    key: 'tideglass',
    name: 'Tideglass',
    description: 'Glassy ice shards catch the last of the distant light.',
    region: 'azure-deep',
    hex: { q: -1, r: 3 },
    asteroidConfigKey: 'sparse',
    features: ['asteroid'],
  },
  {
    key: 'coralward',
    name: 'Coralward',
    description: 'Branching mineral reefs spread through the void.',
    region: 'azure-deep',
    hex: { q: 0, r: 3 },
    asteroidConfigKey: 'dense',
    features: ['minerals', 'asteroid'],
  },
  {
    key: 'deepcurrent',
    name: 'Deepcurrent',
    description: 'Cold currents of dust pull everything toward the trench.',
    region: 'azure-deep',
    hex: { q: -1, r: 4 },
    asteroidConfigKey: 'sparse',
    features: ['nebula'],
  },
  {
    key: 'marrow-trench',
    name: 'Marrow Trench',
    description: 'A mineral-rich trench plunging into blackness.',
    region: 'azure-deep',
    hex: { q: 0, r: 4 },
    asteroidConfigKey: 'dense',
    features: ['minerals'],
  },
  {
    key: 'abyssal-gate',
    name: 'Abyssal Gate',
    description: "The Deep's frontier mouth — the abyss disgorges its hunters here.",
    region: 'azure-deep',
    hex: { q: -1, r: 5 },
    asteroidConfigKey: 'none',
    features: ['blackhole'],
    isEntry: true,
  },
];

/** Existing keys that MUST survive (persistence identities — game_snapshots.sector_id
 *  + roster last_sector_key reference them). */
const LEGACY_KEYS = [
  'sol-prime',
  'orion-belt',
  'vega-reach',
  'cygnus-arm',
  'kepler-spur',
  'andromeda-rim',
  'lyra-fringe',
];

const CORE_REGION = 'core';

// ---------------------------------------------------------------------------
// Build + validate.
// ---------------------------------------------------------------------------
function fail(msg: string): never {
  throw new Error(`generate-galaxy: ${msg}`);
}

function buildNeighbours(): Map<string, string[]> {
  const byKey = new Map(SECTOR_SPECS.map((s) => [s.key, s]));
  const declared = new Set<string>();
  const pairKey = (a: string, b: string): string => [a, b].sort().join('::');
  for (const [a, b] of [...CHOKEPOINTS, ...CROSS_LINKS]) declared.add(pairKey(a, b));

  const adj = new Map<string, Set<string>>();
  for (const s of SECTOR_SPECS) adj.set(s.key, new Set());
  const link = (a: string, b: string): void => {
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };

  // Intra-region edges from hex-adjacency; assert no UNDECLARED cross-region adjacency.
  for (let i = 0; i < SECTOR_SPECS.length; i++) {
    for (let j = i + 1; j < SECTOR_SPECS.length; j++) {
      const a = SECTOR_SPECS[i]!;
      const b = SECTOR_SPECS[j]!;
      if (hexDistance(a.hex, b.hex) !== 1) continue;
      if (a.region === b.region) {
        link(a.key, b.key);
      } else if (!declared.has(pairKey(a.key, b.key))) {
        fail(
          `undeclared cross-region adjacency ${a.key}(${a.region}) <-> ${b.key}(${b.region}); ` +
            `regions must connect only through a declared chokepoint/cross-link`,
        );
      }
    }
  }

  // Explicit cross-region edges (chokepoints + cross-links) — must be hex-adjacent.
  for (const [a, b] of [...CHOKEPOINTS, ...CROSS_LINKS]) {
    const sa = byKey.get(a) ?? fail(`chokepoint/cross-link references unknown key '${a}'`);
    const sb = byKey.get(b) ?? fail(`chokepoint/cross-link references unknown key '${b}'`);
    if (hexDistance(sa.hex, sb.hex) !== 1) {
      fail(`chokepoint/cross-link ${a} <-> ${b} are not hex-adjacent (would draw a long line)`);
    }
    link(a, b);
  }

  // Stable neighbour order: by the SECTOR_SPECS index of each neighbour.
  const order = new Map(SECTOR_SPECS.map((s, i) => [s.key, i]));
  const out = new Map<string, string[]>();
  for (const s of SECTOR_SPECS) {
    out.set(s.key, [...adj.get(s.key)!].sort((x, y) => order.get(x)! - order.get(y)!));
  }
  return out;
}

function validate(neighbours: Map<string, string[]>): void {
  // Unique keys.
  const keys = SECTOR_SPECS.map((s) => s.key);
  if (new Set(keys).size !== keys.length) fail('duplicate sector key');

  // Unique hexes.
  const coords = SECTOR_SPECS.map((s) => `${s.hex.q},${s.hex.r}`);
  if (new Set(coords).size !== coords.length) fail('duplicate hex coordinate');

  // Legacy keys present.
  for (const k of LEGACY_KEYS) {
    if (!keys.includes(k)) fail(`legacy key '${k}' missing — persistence identity would break`);
  }

  // Regions valid; every spec's region is a known region.
  const regionIds = new Set(REGIONS.map((r) => r.id));
  for (const s of SECTOR_SPECS) {
    if (!regionIds.has(s.region)) fail(`sector '${s.key}' has unknown region '${s.region}'`);
  }

  // Symmetric edges + no self-loops + no dangling (derivation guarantees these,
  // but assert defensively).
  for (const s of SECTOR_SPECS) {
    const ns = neighbours.get(s.key)!;
    if (ns.includes(s.key)) fail(`self-loop at '${s.key}'`);
    for (const n of ns) {
      if (!neighbours.has(n)) fail(`'${s.key}' -> '${n}' dangles`);
      if (!neighbours.get(n)!.includes(s.key)) fail(`asymmetric edge ${s.key} -> ${n}`);
    }
  }

  // Whole graph connected (BFS from the default sector).
  const seen = bfs('sol-prime', neighbours, () => true);
  if (seen.size !== SECTOR_SPECS.length) {
    fail(`graph not connected: reached ${seen.size}/${SECTOR_SPECS.length} from sol-prime`);
  }

  // Each region graph-contiguous (BFS within the region). Load-bearing for the
  // P4 contiguous-territory hover-shrink (BFS over same-faction neighbours).
  const byRegion = new Map<string, SectorSpec[]>();
  for (const s of SECTOR_SPECS) (byRegion.get(s.region) ?? byRegion.set(s.region, []).get(s.region)!).push(s);
  for (const [region, members] of byRegion) {
    const start = members[0]!.key;
    const reached = bfs(start, neighbours, (k) => byKey().get(k)!.region === region);
    if (reached.size !== members.length) {
      fail(`region '${region}' is not graph-contiguous (${reached.size}/${members.length})`);
    }
  }

  // Exactly one core↔region edge per frontier region (the chokepoint), and the
  // chokepoint sector belongs to the frontier region (not core).
  const frontier = REGIONS.filter((r) => r.id !== CORE_REGION).map((r) => r.id);
  for (const region of frontier) {
    let crossings = 0;
    for (const s of SECTOR_SPECS) {
      if (s.region !== region) continue;
      for (const n of neighbours.get(s.key)!) {
        if (byKey().get(n)!.region === CORE_REGION) crossings++;
      }
    }
    if (crossings !== 1) fail(`region '${region}' has ${crossings} core edges (expected exactly 1 chokepoint)`);
  }

  // Entry sectors: >= 1 per frontier region; never a core sector.
  for (const region of frontier) {
    const entries = SECTOR_SPECS.filter((s) => s.region === region && s.isEntry);
    if (entries.length < 1) fail(`region '${region}' has no entry sector`);
  }
  for (const s of SECTOR_SPECS) {
    if (s.isEntry && s.region === CORE_REGION) fail(`core sector '${s.key}' must not be an entry sector`);
  }
}

let _byKey: Map<string, SectorSpec> | null = null;
function byKey(): Map<string, SectorSpec> {
  return (_byKey ??= new Map(SECTOR_SPECS.map((s) => [s.key, s])));
}

function bfs(
  start: string,
  neighbours: Map<string, string[]>,
  accept: (key: string) => boolean,
): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const n of neighbours.get(cur)!) {
      if (seen.has(n) || !accept(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Emit.
// ---------------------------------------------------------------------------
function fmtFeatures(fs: SectorFeature[]): string {
  return `[${fs.map((f) => `'${f}'`).join(', ')}]`;
}

function emit(neighbours: Map<string, string[]>): string {
  const sectorLines = SECTOR_SPECS.map((s) => {
    const ns = neighbours.get(s.key)!;
    return `  {
    key: '${s.key}',
    name: '${s.name.replace(/'/g, "\\'")}',
    description: '${s.description.replace(/'/g, "\\'")}',
    region: '${s.region}',
    hex: { q: ${s.hex.q}, r: ${s.hex.r} },
    neighbours: [${ns.map((n) => `'${n}'`).join(', ')}],
    asteroidConfigKey: '${s.asteroidConfigKey}',
    droneCount: AMBIENT_DRONE_FLOOR,
    features: ${fmtFeatures(s.features)},
    defaultSpawn: { x: 0, y: 0 },
  },`;
  }).join('\n');

  const factionLines = REGIONS.map(
    (r) => `  { id: '${r.id}', displayName: '${r.displayName.replace(/'/g, "\\'")}' },`,
  ).join('\n');

  const entryKeys = SECTOR_SPECS.filter((s) => s.isEntry).map((s) => s.key);
  const entryLines = entryKeys.map((k) => `  '${k}',`).join('\n');

  return `/**
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
   *  \`LivingWorldDirector\`'s roaming squad pool provides ALL ambient presence.
   *  Engineering/test rooms still set their own \`droneCount\` directly. */
  droneCount: number;
  /** Static cosmetic feature glyphs for the map (see {@link SectorFeature}). */
  features: SectorFeature[];
  /** Default ship spawn coords for fresh entry into this sector. */
  defaultSpawn: { x: number; y: number };
}

/** A galaxy faction / region. COSMETIC v1 — \`displayName\` is the only rendered
 *  field; ownership/contest derivation is future work (see {@link GalaxySector.region}). */
export interface GalaxyFaction {
  id: string;
  displayName: string;
}

/**
 * Ambient patrol-drone boot-seed floor per galaxy sector. **RETIRED to 0**
 * (drone-warp-in refactor, 2026-06-11). All ambient presence comes from the
 * \`LivingWorldDirector\`'s roaming squad pool, which materialises drones ONLY at
 * entry (edge) sectors and lets them hop inward — so a drone is never conjured
 * in an interior sector out of nowhere. Kept as a named constant (rather than an
 * inline 0) so the retirement is explicit at every call site.
 */
export const AMBIENT_DRONE_FLOOR = 0;

/** The galaxy factions / regions (cosmetic v1). GENERATED — see file header. */
export const GALAXY_FACTIONS: readonly GalaxyFaction[] = [
${factionLines}
];

/**
 * The galaxy: a home core + 3 chokepoint-gated frontier regions (${SECTOR_SPECS.length} sectors).
 * GENERATED — see file header. Do not hand-edit.
 */
export const GALAXY_SECTORS: readonly GalaxySector[] = [
${sectorLines}
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
${entryLines}
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

/** True iff \`toKey\` is a direct neighbour of \`fromKey\` in the graph. */
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

/** True iff \`key\` is an entry (edge) sector — see {@link getEntrySectors}. */
export function isEntrySector(key: string): boolean {
  return ENTRY_SECTOR_KEYS.has(key);
}

/** Standard pointy-top axial→pixel projection. Used by the map renderer. */
export function axialToPixel(hex: AxialHex, size: number): { x: number; y: number } {
  const x = size * Math.sqrt(3) * (hex.q + hex.r / 2);
  const y = size * (3 / 2) * hex.r;
  return { x, y };
}
`;
}

// ---------------------------------------------------------------------------
const neighbours = buildNeighbours();
validate(neighbours);
process.stdout.write(emit(neighbours));
