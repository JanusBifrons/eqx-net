/**
 * The base growth generator (plan soft-leaping-truffle v3, phase D1). Pure.
 *
 * Turns a `BaseProfile` into real catalogue structures the way a builder would:
 *  1. **Plan** what to build from the base's ROLE and WEALTH: the role's chain
 *     (mining → Miners / Gas Collectors; refinery → Smelters, Refineries …),
 *     storage, a Freight Dock, turrets, and at most one huge kind where the
 *     tier allows. Each purchase costs its catalogue `constructionCost` (plus,
 *     for packed kinds, the pack bill's value), until the wealth runs out or
 *     the tier's structure budget is reached.
 *  2. **Lay out** a connector grid around the Capital: rows of connectors with
 *     leaves above and below each one, a bare spine (with relay connectors where
 *     a row gap exceeds connection range), and the huge kind on its own outer
 *     row. Row spacing comes from the tallest structure in the base.
 *  3. **Power** it: Solars until consumption (fence included) is covered, and
 *     batteries for a reserve.
 *  4. **Fence** it (most bases): a rectangle of Shield Pylons around the
 *     extent with a Shield Gate in the middle of each side, tapped from the row
 *     ends.
 *
 * Every placement passes the real `placementRejection` and every edge the real
 * `canConnect`, checked AS the base is built (a slot that fails is skipped), so
 * the result is buildable by construction; `growBase.test.ts` re-checks it.
 */
import { COASTAL_DEFENCE_KINDS, getStructureKind, structureHalfExtents, type StructureKindId } from '../../shared-types/structureKinds.js';
import { RECIPES, packRecipeFor, recipesFor, type RecipeId } from '../../shared-types/recipes.js';
import { BASE_PRICES } from '../../shared-types/economy.js';
import { IDLE_DRAW_FRAC } from '../../shared-types/structurePower.js';
import { canConnect, segmentIntersectsAabb, type GridNode } from '../structures/Grid.js';
import { Connection } from '../structures/Connection.js';
import { placementRejection } from '../structures/placementRules.js';
import { isShieldEmitterKind } from '../structures/gateGeometry.js';
import { seededRandom, type BaseProfile, type BaseTier } from './baseProfile.js';
import type { SectorFeature } from '../galaxy/galaxy.js';
import type { GoodId } from '../../shared-types/goods.js';

/** Bump on ANY change to the generator's output (NPC bases regenerate from the
 *  seed, so a change moves every base).
 *  9→10 (plan coastal-defences): bases buy a tiered mix of gun batteries
 *  (AA, 5" mounts, coastal guns, region-heart super-guns) from their own
 *  random stream; casemates face outward. */
export const BASE_GROWTH_VERSION = 10;

/**
 * Most structures a base of each tier may have (fence included). Measured
 * 2026-11-01 with Reactors powering the fence (a Shield Pylon draws 20, a
 * Reactor makes 240): fenced outpost ~43, settlement ~60, stronghold ~116,
 * citadel ~123. Before the Reactor a fenced outpost needed ~78.
 */
export const TIER_MAX_STRUCTURES: Readonly<Record<BaseTier, number>> = Object.freeze({
  outpost: 50,
  settlement: 80,
  stronghold: 160,
  citadel: 260,
});

export interface GrownPlacement {
  kind: StructureKindId;
  x: number;
  y: number;
  rot?: number;
  /** Selected recipe (processors). */
  recipe?: RecipeId;
  level?: number;
  /** v4 H — the transit link this teleporter ends (paired at run time). */
  link?: string;
}

export interface GrownBase {
  placements: GrownPlacement[];
  /** Index pairs into `placements`, in an order every `canConnect` passes. */
  edges: Array<readonly [number, number]>;
  /** Wealth actually spent. */
  spent: number;
  /** Net power with everything built. */
  netPower: number;
  fencePylons: number;
  fenceGates: number;
  /** Chain stages the base runs (0 raw … 3 end products). */
  stages: number[];
}

const PITCH_X = 640;
const GAP = 20;
const FENCE_MARGIN = 150;
/** Pylon spacing: centre to centre, under the 600 u edge-to-edge range. */
const FENCE_STEP = 660;

const CONN = getStructureKind('connector');
const CONN_HALF = CONN.footprint.h / 2;

/** What a structure costs a generated base (minerals-equivalent). */
export function generatedCost(kind: StructureKindId): number {
  const base = getStructureKind(kind).constructionCost;
  const pack = packRecipeFor(kind);
  if (pack === null) return base;
  let v = 0;
  for (const [g, n] of Object.entries(RECIPES[pack].inputs)) v += BASE_PRICES[g as GoodId] * (n ?? 0);
  return base + v;
}

/**
 * Expected power draw of a structure on a typical day (user ruling
 * 2026-11-01): it draws full power only while active, a small idle trickle
 * otherwise (`structurePower.ts`), and no base runs everything at 100 %.
 * Processors are sized as busy ALL the time: an NPC base is stocked with
 * inputs, so its processors run back to back (sizing them at 60 % browned the
 * stronghold out every other pulse and dropped its fence — user report
 * 2026-11-02, `npcBasePowerStable.test.ts`). Drills 80 %, turrets 15 %;
 * shield emitters hold their walls on the trickle (a fence under fire is paid
 * from surplus and batteries). Generation is sized for this, not for peak.
 */
export const EXPECTED_ACTIVE: Readonly<Partial<Record<StructureKindId, number>>> = Object.freeze({
  miner: 0.8, gas_collector: 0.8, deep_core_rig: 0.8,
  reclaimer: 1, smelter: 1, refinery: 1, silicon_works: 1, hydroponics: 1,
  fabricator: 1, munitions_works: 1, ore_processing_complex: 1, assembly_plant: 1,
  turret: 0.15, laser_bolt_turret: 0.15, missile_turret: 0.15, autocannon_turret: 0.15,
  // Coastal defences: guns draw full power only while engaged, like turrets.
  aa_quad_40mm: 0.15, dp_mount_5in: 0.15, coastal_casemate_8in: 0.15, coastal_turret_11in: 0.15,
  coastal_barbette_16in: 0.15, coastal_lindemann: 0.15, siege_gun_80cm: 0.15,
  // A mine layer lays only until its field is full.
  mine_layer: 0.2,
  // D3 — residents live there around the clock.
  habitat_module: 0.9, tower_module: 0.9,
});

export function expectedDraw(kind: StructureKindId): number {
  const cons = getStructureKind(kind).powerConsumption;
  const u = EXPECTED_ACTIVE[kind] ?? 0;
  return cons * (u + (1 - u) * IDLE_DRAW_FRAC);
}

const HUGE: ReadonlySet<StructureKindId> = new Set(['deep_core_rig', 'ore_processing_complex', 'assembly_plant']);

/** Weapons that fire SHOTS. A fence blocks every shot, its owner's own
 *  included (user ruling 2026-11-02), so a fenced base puts these OUTSIDE its
 *  fence, on bastions (see growOnce). */
export const TURRET_KINDS: ReadonlySet<StructureKindId> = new Set<StructureKindId>([
  'turret', 'laser_bolt_turret', 'missile_turret', 'autocannon_turret', ...COASTAL_DEFENCE_KINDS,
]);
/** Guns that fire only through an arc (casemates, the siege gun): a base
 *  turns them to face outward. */
const ARC_LIMITED: ReadonlySet<StructureKindId> = new Set(
  COASTAL_DEFENCE_KINDS.filter((k) => {
    const m = getStructureKind(k).mounts![0]!;
    return m.arcMax - m.arcMin < 2 * Math.PI - 1e-6;
  }),
);
/** Rotation that turns an arc-limited gun (rest bearing +y at 0) to face
 *  (dx, dy): +y → 0, −x → 90, −y → 180, +x → 270. */
function facingRot(dx: number, dy: number): number {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 270 : 90;
  return dy >= 0 ? 0 : 180;
}
/** Random stream for the defence mix, apart from the role/level stream so
 *  picking guns never shifts what else a base builds. */
const DEFENCE_STREAM = 0x3c6ef372;

/**
 * Coastal defences — the guns a base buys for its tier (plan coastal-defences),
 * in buy order: the cheap screen first, the big guns last (wealth runs out on
 * the biggest). Light energy turrets keep the old role; the quad AA screens
 * fighters, the 5" mounts take gunships, the coastal guns take capitals.
 */
function defenceMix(profile: BaseProfile, drnd: () => number): StructureKindId[] {
  const energy = (): StructureKindId => (drnd() < 0.5 ? 'turret' : 'laser_bolt_turret');
  const out: StructureKindId[] = [...(profile.superGuns ?? [])];
  switch (profile.tier) {
    case 'outpost':
      out.push(energy());
      if (drnd() < 0.5) out.push('aa_quad_40mm');
      break;
    case 'settlement':
      out.push(energy(), 'aa_quad_40mm', 'dp_mount_5in');
      if (drnd() < 0.5) out.push('dp_mount_5in');
      break;
    case 'stronghold':
      out.push(energy(), energy(), 'aa_quad_40mm', 'dp_mount_5in', 'dp_mount_5in');
      out.push(drnd() < 0.65 ? 'coastal_casemate_8in' : 'coastal_turret_11in');
      break;
    case 'citadel':
      out.push(energy(), energy(), 'aa_quad_40mm', 'aa_quad_40mm', 'dp_mount_5in', 'dp_mount_5in');
      out.push(drnd() < 0.5 ? 'coastal_casemate_8in' : 'coastal_turret_11in', 'coastal_barbette_16in');
      if (drnd() < 0.5) out.push('coastal_lindemann');
      break;
  }
  return out;
}
/** A bastion's inside relay sits this far inside the fence line, its hub this
 *  far outside (both clear of the pylons' boxes). */
const BASTION_IN = 120;
const BASTION_OUT = 220;
/** How far a bastion's outward gun stands off past its hub, so guns above
 *  and below the hub (half-width up to this) fit beside a big battery. */
const OUTWARD_CLEAR = 130;

/** Stage each processor kind's main output belongs to (for the coverage rule). */
function stageOf(kind: StructureKindId, recipe: RecipeId | undefined): number | null {
  if (kind === 'miner' || kind === 'gas_collector' || kind === 'deep_core_rig') return 0;
  if (recipe === undefined) return null;
  const o = RECIPES[recipe].outputs[0];
  if (!o || !('good' in o)) return null;
  const g = o.good;
  if (g === 'alloy' || g === 'fuel' || g === 'polymer' || g === 'silicon' || g === 'provisions' || g === 'minerals') return 1;
  if (g === 'components' || g === 'electronics' || g === 'munitions') return 2;
  return 3;
}

interface Want {
  kind: StructureKindId;
  recipe?: RecipeId;
  /** v4 H — the transit link a teleporter ends. */
  link?: string;
}

/** The role's production units, in the order a builder adds them. */
function roleUnits(profile: BaseProfile, features: readonly SectorFeature[], rnd: () => number): Want[] {
  const nebula = features.includes('nebula');
  const big = profile.tier === 'stronghold' || profile.tier === 'citadel';
  switch (profile.role) {
    case 'mining': {
      const out: Want[] = [{ kind: 'miner' }];
      if (nebula) out.push({ kind: 'gas_collector' });
      if (big) out.unshift({ kind: 'deep_core_rig' });
      return out;
    }
    case 'refinery': {
      const out: Want[] = [{ kind: 'smelter', recipe: 'smelt_alloy' }, { kind: 'refinery', recipe: nebula ? 'refine_gas' : 'refine_ice_fuel' }];
      if (features.includes('minerals') || features.includes('blackhole')) out.push({ kind: 'silicon_works', recipe: 'make_silicon' });
      out.push({ kind: 'reclaimer', recipe: 'reclaim_salvage' });
      if (big) out.unshift({ kind: 'ore_processing_complex', recipe: 'opc_alloy' });
      return out;
    }
    case 'workshop': {
      // Two adjacent stages of one chain, ending in a product it sells.
      const chains: Want[][] = [
        [{ kind: 'refinery', recipe: 'refine_ice_fuel' }, { kind: 'hydroponics', recipe: 'grow_provisions' }],
        [{ kind: 'smelter', recipe: 'smelt_alloy' }, { kind: 'fabricator', recipe: 'fab_components' }],
        [{ kind: 'refinery', recipe: nebula ? 'refine_gas' : 'refine_ice_fuel' }, { kind: 'munitions_works', recipe: 'make_munitions' }],
      ];
      return chains[Math.floor(rnd() * chains.length)]!;
    }
    case 'manufactory':
      return [
        { kind: 'fabricator', recipe: 'fab_components' },
        { kind: 'fabricator', recipe: 'fab_electronics' },
        { kind: 'munitions_works', recipe: 'make_munitions' },
      ];
    case 'assembly':
      return [
        { kind: 'assembly_plant', recipe: rnd() < 0.5 ? 'assemble_machinery' : 'assemble_consumer_goods' },
        { kind: 'fabricator', recipe: 'fab_components' },
        { kind: 'fabricator', recipe: 'fab_electronics' },
      ];
    case 'trade':
      return [{ kind: 'cargo_bay' }];
    case 'transit':
      // A hub's business is its teleporters (one per link, added below).
      return [{ kind: 'cargo_bay' }];
    case 'military':
      // v4 M — turret-heavy: every kind of gun, repeated while wealth lasts
      // (a fenced base puts them on bastions outside the fence). Coastal
      // defences: the AA screen, 5" mounts and the medium coastal guns too.
      return [
        { kind: 'laser_bolt_turret' }, { kind: 'autocannon_turret' }, { kind: 'missile_turret' }, { kind: 'turret' },
        { kind: 'aa_quad_40mm' }, { kind: 'dp_mount_5in' }, { kind: 'coastal_casemate_8in' }, { kind: 'coastal_turret_11in' },
      ];
    case 'colony': {
      // A habitat station: housing first, spires once it's a settlement or bigger, and
      // hydroponics to grow part of its own provisions.
      const out: Want[] = [
        { kind: 'habitat_module', recipe: 'habitat_upkeep' },
        { kind: 'habitat_module', recipe: 'habitat_upkeep' },
      ];
      if (profile.tier !== 'outpost') {
        out.push({ kind: 'tower_module', recipe: 'tower_upkeep' }, { kind: 'hydroponics', recipe: 'grow_provisions' });
      }
      return out;
    }
  }
}

/** The build list: what the base buys, within its wealth and tier budget. */
function planBuild(profile: BaseProfile, features: readonly SectorFeature[], rnd: () => number, drnd: () => number): { wants: Want[]; spent: number } {
  const wants: Want[] = [];
  let budget = profile.wealth;
  let spent = 0;
  const cap = Math.floor(TIER_MAX_STRUCTURES[profile.tier] * 0.6); // leave room for connectors, power, fence
  const unitCap = { outpost: 2, settlement: 5, stronghold: 10, citadel: 16 }[profile.tier];
  const storageCap = { outpost: 2, settlement: 4, stronghold: 8, citadel: 14 }[profile.tier] * (profile.role === 'trade' ? 2 : 1);
  const counts = new Map<StructureKindId, number>();
  const solarCost = getStructureKind('solar').constructionCost;
  const solarOut = getStructureKind('solar').powerOutput;
  const buy = (w: Want): boolean => {
    const n = counts.get(w.kind) ?? 0;
    const storage = w.kind === 'cargo_bay' || w.kind === 'freight_dock';
    if (n >= (storage ? storageCap : unitCap)) return false;
    // A purchase includes the Solars that power it (a builder pays for both).
    const c = generatedCost(w.kind) + Math.ceil(expectedDraw(w.kind) / solarOut) * solarCost;
    if (c > budget || wants.length >= cap) return false;
    counts.set(w.kind, n + 1);
    budget -= c;
    spent += c;
    wants.push(w);
    return true;
  };
  // Every trading base has a dock and some storage; defence scales with tier.
  // (A military base trades nothing: its cargo bay holds munitions and fuel.)
  if (profile.role !== 'military') buy({ kind: 'freight_dock' });
  buy({ kind: 'cargo_bay' });
  // Coastal defences: a tiered mix of gun batteries (super-guns first).
  for (const kind of defenceMix(profile, drnd)) buy({ kind });
  // Big bases mine their approaches.
  const mineLayers = { outpost: 0, settlement: 0, stronghold: 1, citadel: 2 }[profile.tier] + (profile.role === 'military' ? 1 : 0);
  for (let t = 0; t < mineLayers; t++) buy({ kind: 'mine_layer' });
  // The role's chain, repeated (huge kinds once) while wealth lasts.
  const units = roleUnits(profile, features, rnd);
  let hugeBought = false;
  for (let round = 0; round < 200; round++) {
    let any = false;
    for (const u of units) {
      if (HUGE.has(u.kind)) {
        if (hugeBought) continue;
        if (buy(u)) { hugeBought = true; any = true; }
        continue;
      }
      if (buy(u)) any = true;
    }
    // Trade hubs and every 3rd round: more storage.
    if (profile.role === 'trade' || round % 3 === 2) {
      if (buy({ kind: profile.role === 'trade' && round % 4 === 3 ? 'freight_dock' : 'cargo_bay' })) any = true;
    }
    if (!any) break;
  }
  return { wants, spent };
}

interface Node extends GridNode {
  kind: StructureKindId;
}

class Builder {
  readonly placements: GrownPlacement[] = [];
  readonly edges: Array<readonly [number, number]> = [];
  readonly placed: Array<{ x: number; y: number; radius: number; halfW: number; halfH: number }> = [];
  readonly nodes = new Map<string, Node>();
  readonly adj = new Map<string, Connection[]>();
  private cid = 0;

  /** Place if the real overlap rule allows; returns the index or -1. */
  tryPlace(p: GrownPlacement): number {
    const rot = p.rot ?? 0;
    if (placementRejection(p.kind, p.x, p.y, this.placed, null, rot) !== null) return -1;
    const k = getStructureKind(p.kind);
    const { hw, hh } = structureHalfExtents(p.kind, rot);
    // Never on top of an existing link (a link needs a clear line of sight).
    for (const [ea, eb] of this.edges) {
      const a = this.placements[ea]!, b = this.placements[eb]!;
      if (segmentIntersectsAabb(a.x, a.y, b.x, b.y, p.x - hw, p.y - hh, p.x + hw, p.y + hh)) return -1;
    }
    const i = this.placements.length;
    this.placements.push(p);
    this.placed.push({ x: p.x, y: p.y, radius: k.radius, halfW: hw, halfH: hh });
    this.nodes.set(`s${i}`, {
      id: `s${i}`, kind: p.kind, x: p.x, y: p.y, radius: k.radius, halfW: hw, halfH: hh,
      isHub: k.isHub, isCapital: p.kind === 'capital', isConnector: p.kind === 'connector',
      isShieldPylon: isShieldEmitterKind(p.kind), maxConnections: k.maxConnections,
      connectionRange: k.connectionRange, powerOutput: k.powerOutput, powerConsumption: k.powerConsumption,
      isConstructed: true,
    });
    return i;
  }

  /** Link if the real connection rule allows. */
  tryLink(a: number, b: number): boolean {
    const na = this.nodes.get(`s${a}`)!, nb = this.nodes.get(`s${b}`)!;
    const r = canConnect(na, nb, this.adj, this.nodes);
    if (!r.ok) return false;
    const c = new Connection(this.cid++, na.id, nb.id, 1);
    (this.adj.get(na.id) ?? this.adj.set(na.id, []).get(na.id)!).push(c);
    (this.adj.get(nb.id) ?? this.adj.set(nb.id, []).get(nb.id)!).push(c);
    this.edges.push([a, b]);
    return true;
  }

  /** Remove the last placement (a leaf that couldn't be linked). */
  undoLast(): void {
    const i = this.placements.length - 1;
    this.placements.pop();
    this.placed.pop();
    this.nodes.delete(`s${i}`);
  }
}

/**
 * Grow a base. `features` are the sector's (refinery recipes, gas). Pure and
 * deterministic per (profile, seed).
 */
export function growBase(profile: BaseProfile, seed: number, features: readonly SectorFeature[] = []): GrownBase {
  // Lay out, measure the real draw (the fence size depends on the layout),
  // then lay out again with enough Solars. Converges in a few passes.
  // A base that comes out over its tier's budget spends less and regrows.
  let p = profile;
  let out = balanced(p, seed, features);
  for (let pass = 0; pass < 8 && out.placements.length > TIER_MAX_STRUCTURES[profile.tier]; pass++) {
    p = { ...p, wealth: Math.floor(p.wealth * 0.85) };
    out = balanced(p, seed, features);
  }
  return out;
}

function balanced(profile: BaseProfile, seed: number, features: readonly SectorFeature[]): GrownBase {
  let extra = 0;
  let out = growOnce(profile, seed, features, extra);
  for (let pass = 0; pass < 6 && out.netPower < 0; pass++) {
    extra += Math.ceil(-out.netPower / getStructureKind('solar').powerOutput) + 1;
    out = growOnce(profile, seed, features, extra);
  }
  return out;
}

function growOnce(profile: BaseProfile, seed: number, features: readonly SectorFeature[], extraSolars: number): GrownBase {
  const rnd = seededRandom(seed ^ 0x5bd1e995);
  const { wants, spent } = planBuild(profile, features, rnd, seededRandom(seed ^ DEFENCE_STREAM));
  // v4 H — one teleporter per transit link this base ends (outside the budget:
  // the network needs both ends).
  for (const id of profile.links ?? []) wants.push({ kind: 'teleporter', link: id });
  const huge = wants.filter((w) => HUGE.has(w.kind));
  // A fenced base's turrets go on bastions outside the fence (placed after it).
  const posts = profile.fenced ? wants.filter((w) => TURRET_KINDS.has(w.kind)) : [];
  const normal = wants.filter((w) => !HUGE.has(w.kind) && !(profile.fenced && TURRET_KINDS.has(w.kind)));
  // Power: role consumption + an estimate for the fence; Solars to cover it,
  // a battery per ~4 consumers for a reserve.
  let consumption = 0;
  for (const w of wants) consumption += expectedDraw(w.kind);
  // The fence's draw is measured after layout (see growBase); start with none.
  const fenceDraw = 0;
  const capOut = getStructureKind('capital').powerOutput;
  const solar = getStructureKind('solar').powerOutput;
  // Power the deficit with Reactors (fuel-burning, ~8 Solars each) and the
  // remainder with Solars. A bigger base banks its reserve in a Battery Bank.
  const reactorOut = getStructureKind('reactor').powerOutput;
  const deficit = Math.max(0, consumption + fenceDraw - capOut) + extraSolars * solar;
  const reactors = Math.floor(deficit / reactorOut);
  const solars = Math.max(0, Math.ceil((deficit - reactors * reactorOut) / solar));
  for (let r = 0; r < reactors; r++) normal.push({ kind: 'reactor' });
  for (let s = 0; s < solars; s++) normal.push({ kind: 'solar' });
  // Batteries are a real strategy (user): a fence under fire drains the grid's
  // surplus and then its batteries, so fenced bases bank extra reserve.
  const batteries = Math.max(1, Math.round(wants.length / 6)) + (profile.fenced ? 2 : 0);
  if (batteries >= 5) normal.push({ kind: 'battery_bank' });
  else for (let b = 0; b < batteries; b++) normal.push({ kind: 'battery' });

  // Tallest normal leaf sets the row spacing.
  let tallest = 0;
  for (const w of normal) tallest = Math.max(tallest, getStructureKind(w.kind).footprint.h);
  const reach = CONN_HALF + GAP + tallest; // a leaf's far edge from its row line
  const pitchY = 2 * reach + GAP;
  // Columns per side: enough slots for the base with a square-ish shape.
  const cols = Math.max(1, Math.ceil(Math.sqrt(normal.length / 2) * 0.8));

  const B = new Builder();
  const cap = B.tryPlace({ kind: 'capital', x: 0, y: 0 });
  const rowConn = new Map<number, number[]>(); // row j → connector index per column (-cols..cols, spine at 0)
  const spineAt = new Map<number, number>(); // row j → spine connector (or the Capital for j = 0)
  spineAt.set(0, cap);

  // Rows grow outward: 0, 1, -1, 2, -2, …
  const rowOrder: number[] = [0];
  const addRow = (j: number): boolean => {
    if (rowConn.has(j)) return true;
    const y = j * pitchY;
    let spine = spineAt.get(j);
    if (spine === undefined) {
      // Spine connector at (0, y), reached through relays from the row nearer 0.
      const from = j - Math.sign(j);
      let prev = spineAt.get(from)!;
      const prevY = from * pitchY;
      const span = Math.abs(y - prevY);
      const relays = Math.max(0, Math.ceil((span - 2 * CONN_HALF) / 560) - 1);
      for (let r = 1; r <= relays; r++) {
        const ry = prevY + Math.sign(j) * (span * r) / (relays + 1);
        const ri = B.tryPlace({ kind: 'connector', x: 0, y: ry });
        if (ri < 0 || !B.tryLink(prev, ri)) return false;
        prev = ri;
      }
      spine = B.tryPlace({ kind: 'connector', x: 0, y });
      if (spine < 0 || !B.tryLink(prev, spine)) return false;
      spineAt.set(j, spine);
    }
    const row: number[] = [];
    for (const side of [1, -1]) {
      let prev = spine;
      for (let i = 1; i <= cols; i++) {
        const ci = B.tryPlace({ kind: 'connector', x: side * i * PITCH_X, y });
        if (ci < 0 || !B.tryLink(prev, ci)) break;
        row.push(ci);
        prev = ci;
      }
    }
    rowConn.set(j, row);
    return true;
  };

  // Fill leaf slots, biggest first (they need the room), nearest rows first.
  const queue = [...normal].sort((a, b) => {
    const fa = getStructureKind(a.kind).footprint, fb = getStructureKind(b.kind).footprint;
    return fb.w * fb.h - fa.w * fa.h;
  });
  const used = new Set<string>();
  let rowCursor = 0;
  addRow(0);
  for (const w of queue) {
    let placedIt = false;
    for (let attempt = 0; attempt < 64 && !placedIt; attempt++) {
      for (const j of rowOrder) {
        for (const c of rowConn.get(j) ?? []) {
          for (const side of [1, -1]) {
            const key = `${c}:${side}`;
            if (used.has(key)) continue;
            const conn = B.placements[c]!;
            const fp = getStructureKind(w.kind).footprint;
            const p: GrownPlacement = { kind: w.kind, x: conn.x, y: conn.y + side * (CONN_HALF + GAP + fp.h / 2) };
            // An arc-limited gun (unfenced base) faces away from the Capital.
            if (ARC_LIMITED.has(w.kind)) p.rot = p.y + side >= 0 ? 0 : 180;
            if (w.recipe) p.recipe = w.recipe;
            if (w.link) p.link = w.link;
            const li = B.tryPlace(p);
            if (li < 0) continue;
            if (!B.tryLink(c, li)) { B.undoLast(); continue; }
            used.add(key);
            placedIt = true;
            break;
          }
          if (placedIt) break;
        }
        if (placedIt) break;
      }
      if (!placedIt) {
        rowCursor++;
        const j = rowCursor % 2 === 1 ? (rowCursor + 1) / 2 : -rowCursor / 2;
        if (!addRow(j)) break;
        rowOrder.push(j);
      }
    }
  }

  // The huge kind sits on its own outer row above the base (its far side free).
  for (const w of huge) {
    const top = Math.max(...rowConn.keys()) + 1;
    if (!addRow(top)) continue;
    rowOrder.push(top);
    const spine = spineAt.get(top)!;
    const fp = getStructureKind(w.kind).footprint;
    // Its own short spine extension, then the huge kind beyond it.
    const ext = B.tryPlace({ kind: 'connector', x: 0, y: B.placements[spine]!.y + reach });
    if (ext < 0 || !B.tryLink(spine, ext)) continue;
    const p: GrownPlacement = { kind: w.kind, x: 0, y: B.placements[ext]!.y + CONN_HALF + GAP + fp.h / 2 };
    if (w.recipe) p.recipe = w.recipe;
    const li = B.tryPlace(p);
    if (li >= 0 && !B.tryLink(ext, li)) B.undoLast();
  }

  // Bastions reach out from a row's end connector, and the side gates sit on
  // row 0, so a fenced base with turrets needs a row off the gate line.
  if (posts.length > 0 && ![...rowConn.keys()].some((j) => j !== 0)) {
    if (addRow(-1)) rowOrder.push(-1);
  }
  // v4 M — a garrison is mostly guns: give it a row (two bastions, up to six
  // guns) for every six it bought.
  if (profile.role === 'military') {
    // Big batteries crowd a bastion, so budget a row per four guns.
    const need = Math.ceil(posts.length / 4);
    for (let k = 1; [...rowConn.keys()].filter((j) => j !== 0).length < need && k <= 6; k++) {
      for (const j of [-k, k]) {
        if (rowConn.has(j)) continue;
        if (addRow(j)) rowOrder.push(j);
      }
    }
  }

  // Fence: a rectangle around everything, a gate mid-side, row ends tapped.
  let fencePylons = 0;
  let fenceGates = 0;
  if (profile.fenced) {
    let fx = 0, fy = 0;
    for (const q of B.placed) {
      fx = Math.max(fx, Math.abs(q.x) + q.halfW);
      fy = Math.max(fy, Math.abs(q.y) + q.halfH);
    }
    fx = Math.ceil((fx + FENCE_MARGIN) / 10) * 10;
    fy = Math.ceil((fy + FENCE_MARGIN) / 10) * 10;
    const along = (a: number, b: number): number[] => {
      const n = Math.max(1, Math.ceil(Math.abs(b - a) / FENCE_STEP));
      const out: number[] = [];
      for (let k = 0; k < n; k++) out.push(a + ((b - a) * k) / n);
      return out;
    };
    // Ring points (counter-clockwise from bottom-left), with the mid-side
    // points snapped to 0 so each side has a gate exactly in its middle.
    const ring: Array<[number, number, number]> = []; // x, y, rot (-1 = pylon)
    const side = (from: [number, number], to: [number, number], gateRot: number) => {
      const horizontal = from[1] === to[1];
      const pts = horizontal ? along(from[0], to[0]).map((x) => [x, from[1]] as const) : along(from[1], to[1]).map((y) => [from[0], y] as const);
      // Insert the gate at the side's middle (0 on the free axis).
      ring.push([pts[0]![0], pts[0]![1], -1]);
      let gated = false;
      for (let k = 1; k < pts.length; k++) {
        const prev = pts[k - 1]!, cur = pts[k]!;
        const a = horizontal ? prev[0] : prev[1], b = horizontal ? cur[0] : cur[1];
        if (!gated && Math.sign(a) !== Math.sign(b) && a !== 0) {
          ring.push(horizontal ? [0, from[1], gateRot] : [from[0], 0, gateRot]);
          gated = true;
        }
        if (b === 0 && !gated) {
          ring.push(horizontal ? [0, from[1], gateRot] : [from[0], 0, gateRot]);
          gated = true;
          continue;
        }
        ring.push([cur[0], cur[1], -1]);
      }
      if (!gated) ring.push(horizontal ? [0, from[1], gateRot] : [from[0], 0, gateRot]);
    };
    side([-fx, -fy], [fx, -fy], 0);
    side([fx, -fy], [fx, fy], 90);
    side([fx, fy], [-fx, fy], 0);
    side([-fx, fy], [-fx, -fy], 90);
    const first = B.placements.length;
    const idx: number[] = [];
    for (const [x, y, rot] of ring) {
      const i = rot >= 0
        ? B.tryPlace({ kind: 'shield_gate', x, y, rot })
        : B.tryPlace({ kind: 'shield_pylon', x, y });
      if (i >= 0) {
        idx.push(i);
        if (rot >= 0) fenceGates++;
      }
    }
    fencePylons = B.placements.length - first;
    for (let k = 0; k < idx.length; k++) B.tryLink(idx[k]!, idx[(k + 1) % idx.length]!);
    // Bastions: turrets OUTSIDE the fence, so their fire never crosses their
    // own wall. From a row's end connector, a relay just inside the fence links
    // (between two pylons) to a hub just outside; turrets hang off the hub.
    // Rows nearest the middle first, off the gate row; each hub takes up to 3.
    const rowsByDistance = [...rowConn.keys()].filter((j) => j !== 0).sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
    // Coastal defences: build the bastions first (enough hubs for the guns at
    // up to three each), then seat the guns biggest first: the big batteries
    // take the outward slots (clear water, no fence beside them), the rest go
    // above and below. An arc-limited gun turns to face out from the base.
    const hubs: Array<{ hub: number; sideX: number; y: number }> = [];
    const hubsNeeded = Math.ceil(posts.length / 3);
    for (const j of rowsByDistance) {
      for (const sideX of [1, -1]) {
        if (hubs.length >= hubsNeeded) break;
        const end = (rowConn.get(j) ?? []).find((c) => B.placements[c]!.x === sideX * cols * PITCH_X);
        if (end === undefined) continue;
        const y = B.placements[end]!.y;
        const relay = B.tryPlace({ kind: 'connector', x: sideX * (fx - BASTION_IN), y });
        if (relay < 0) continue;
        if (!B.tryLink(end, relay)) { B.undoLast(); continue; }
        const hub = B.tryPlace({ kind: 'connector', x: sideX * (fx + BASTION_OUT), y });
        if (hub < 0) continue;
        if (!B.tryLink(relay, hub)) { B.undoLast(); continue; }
        hubs.push({ hub, sideX, y });
      }
      if (hubs.length >= hubsNeeded) break;
    }
    const byArea = [...posts].sort((a, b) => {
      const fa = getStructureKind(a.kind).footprint, fb = getStructureKind(b.kind).footprint;
      return fb.w * fb.h - fa.w * fa.h;
    });
    const seated = new Array<boolean>(byArea.length).fill(false);
    const seat = (h: { hub: number; sideX: number; y: number }, slot: number): void => {
      for (let k = 0; k < byArea.length; k++) {
        if (seated[k]) continue;
        const w = byArea[k]!;
        const rot = ARC_LIMITED.has(w.kind) ? facingRot(h.sideX, 0) : 0;
        const { hw, hh } = structureHalfExtents(w.kind, rot);
        const hx = B.placements[h.hub]!.x;
        // The outward gun stands off past the hub so guns above and below it
        // (up to OUTWARD_CLEAR half-width) still fit beside it.
        const p: GrownPlacement = slot === 0
          ? { kind: w.kind, x: hx + h.sideX * (CONN_HALF + GAP + OUTWARD_CLEAR + hw), y: h.y }
          : { kind: w.kind, x: hx, y: h.y + slot * (CONN_HALF + GAP + hh) };
        if (rot !== 0) p.rot = rot;
        const li = B.tryPlace(p);
        if (li < 0) continue; // try a smaller gun in this slot
        if (!B.tryLink(h.hub, li)) { B.undoLast(); continue; }
        seated[k] = true;
        return;
      }
    };
    for (const h of hubs) seat(h, 0);
    for (const slot of [1, -1]) for (const h of hubs) seat(h, slot);
    // Guns that found no bastion are left out rather than placed inside
    // the fence, where their own wall would stop every shot.
    // Taps: every row's end connectors link the nearest side emitter.
    for (const [, row] of rowConn) {
      for (const c of row) {
        const cp = B.placements[c]!;
        if (Math.abs(cp.x) !== cols * PITCH_X) continue;
        let best = -1, bestD = Infinity;
        for (const e of idx) {
          const ep = B.placements[e]!;
          if (Math.sign(ep.x) !== Math.sign(cp.x) || Math.abs(ep.x) !== fx) continue;
          const d = Math.abs(ep.y - cp.y);
          if (d < bestD) { bestD = d; best = e; }
        }
        if (best >= 0) B.tryLink(c, best);
      }
    }

  }

  // Levels: wealthy bases upgrade processors and turrets up to their level cap.
  const upgradeable = new Set<StructureKindId>(['turret', 'smelter', 'refinery', 'fabricator', 'miner', 'solar']);
  for (const p of B.placements) {
    if (upgradeable.has(p.kind) && profile.levelCap > 1) p.level = 1 + Math.floor(rnd() * profile.levelCap);
  }

  let netPower = 0;
  for (const p of B.placements) {
    const k = getStructureKind(p.kind);
    netPower += k.powerOutput - expectedDraw(p.kind);
  }
  const stages = new Set<number>();
  for (const p of B.placements) {
    const s = stageOf(p.kind, p.recipe ?? (recipesFor as (k: string) => RecipeId[])(p.kind)?.[0]);
    if (s !== null) stages.add(s);
  }
  return {
    placements: B.placements,
    edges: B.edges,
    spent,
    netPower: Math.round(netPower),
    fencePylons,
    fenceGates,
    stages: [...stages].sort(),
  };
}
