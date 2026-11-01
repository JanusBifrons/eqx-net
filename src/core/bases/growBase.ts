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
import { getStructureKind, structureHalfExtents, type StructureKindId } from '../../shared-types/structureKinds.js';
import { RECIPES, packRecipeFor, recipesFor, type RecipeId } from '../../shared-types/recipes.js';
import { BASE_PRICES } from '../../shared-types/economy.js';
import { canConnect, type GridNode } from '../structures/Grid.js';
import { Connection } from '../structures/Connection.js';
import { placementRejection } from '../structures/placementRules.js';
import { isShieldEmitterKind } from '../structures/gateGeometry.js';
import { seededRandom, type BaseProfile, type BaseTier } from './baseProfile.js';
import type { SectorFeature } from '../galaxy/galaxy.js';
import type { GoodId } from '../../shared-types/goods.js';

/** Bump on ANY change to the generator's output (NPC bases regenerate from the
 *  seed, so a change moves every base). */
export const BASE_GROWTH_VERSION = 2;

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

const HUGE: ReadonlySet<StructureKindId> = new Set(['deep_core_rig', 'ore_processing_complex', 'assembly_plant']);

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
  }
}

/** The build list: what the base buys, within its wealth and tier budget. */
function planBuild(profile: BaseProfile, features: readonly SectorFeature[], rnd: () => number): { wants: Want[]; spent: number } {
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
    const c = generatedCost(w.kind) + Math.ceil(getStructureKind(w.kind).powerConsumption / solarOut) * solarCost;
    if (c > budget || wants.length >= cap) return false;
    counts.set(w.kind, n + 1);
    budget -= c;
    spent += c;
    wants.push(w);
    return true;
  };
  // Every trading base has a dock and some storage; defence scales with tier.
  buy({ kind: 'freight_dock' });
  buy({ kind: 'cargo_bay' });
  const turrets = { outpost: 1, settlement: 2, stronghold: 4, citadel: 6 }[profile.tier];
  for (let t = 0; t < turrets; t++) buy({ kind: 'turret' });
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
  const { wants, spent } = planBuild(profile, features, rnd);
  const huge = wants.filter((w) => HUGE.has(w.kind));
  const normal = wants.filter((w) => !HUGE.has(w.kind));
  // Power: role consumption + an estimate for the fence; Solars to cover it,
  // a battery per ~4 consumers for a reserve.
  let consumption = 0;
  for (const w of wants) consumption += getStructureKind(w.kind).powerConsumption;
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
  const batteries = Math.max(1, Math.round(wants.length / 6));
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
            if (w.recipe) p.recipe = w.recipe;
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
    netPower += k.powerOutput - k.powerConsumption;
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
    netPower,
    fencePylons,
    fenceGates,
    stages: [...stages].sort(),
  };
}
