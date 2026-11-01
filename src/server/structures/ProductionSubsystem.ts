/**
 * Production on the grid (plan soft-leaping-truffle v3, P2b). Runs once per
 * 1 Hz grid pulse, after power and construction.
 *
 * Each built processor (Smelter, Refinery, Fabricator, …) runs one recipe:
 *  1. Start a cycle by taking the recipe's inputs from its NETWORK's storage
 *     (the same-owner storage in its grid component: Capital bank, Cargo Bays,
 *     Freight Docks). All or nothing: a missing input leaves it "starved".
 *  2. Advance one step per powered pulse.
 *  3. When the cycle completes, put the outputs into network storage. If they
 *     don't fit, it stays "blocked" until there is room.
 * Scarce inputs are shared round-robin in a fixed order, so results are
 * deterministic.
 *
 * Storage holds are mutated in place, exactly like mining and construction do
 * with the Capital bank; `StorageService.flushDirty()` persists them on the
 * same pulse. A cycle's inputs are consumed when it starts, so a processor never
 * makes value from nothing.
 *
 * Allocation: the processor and network lists are reused arrays; steady-state
 * pulses allocate nothing (#14).
 */
import { GOOD_DEFS, GOOD_IDS, type GoodId } from '../../shared-types/goods.js';
import { RECIPES, type RecipeId, type RecipeOutput } from '../../shared-types/recipes.js';
import { PROD_STATE, defaultRecipeFor, isProcessorKind } from '../../shared-types/production.js';
import { getStructureKind, type StructureKindId } from '../../shared-types/structureKinds.js';
import { holdCapacityOf, isOperationalStorage } from '../cargo/StorageService.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';

/** A blueprint-scaled recipe (Living World's `applyBlueprint`). */
export interface EffectiveRecipe {
  inputs: Readonly<Partial<Record<GoodId, number>>>;
  outputs: readonly RecipeOutput[];
  cyclePulses: number;
}

export interface ProductionDeps {
  registry: StructureRegistry;
  /** Battery-backed power for a structure's component. */
  powered(id: string): boolean;
  /** Ids in the same grid component as `id` (including `id`). */
  componentOf(id: string): readonly string[];
  /**
   * The blueprint loaded in a processor, applied to a recipe that needs one;
   * null when none is loaded. ABSENT until Living World's blueprint items land
   * (W2): blueprint recipes then run at base values.
   */
  blueprintFor?(rec: StructureRecord, recipe: RecipeId): EffectiveRecipe | null;
}

export class ProductionSubsystem {
  private readonly procs: StructureRecord[] = [];
  private readonly net: StructureRecord[] = [];
  private readonly free: number[] = [];
  /** The network last collected (component array + owner): processors in the
   *  same component reuse it, so a pulse scans each component once. Reset by
   *  `pulse()` (storage may have been built or removed since). */
  private netComponent: readonly string[] | null = null;
  private netOwner = '';
  private pulses = 0;
  /** Outputs completed over the subsystem's life (tests, diagnostics). */
  cyclesCompleted = 0;

  constructor(private readonly d: ProductionDeps) {}

  /** The recipe a processor runs (its selection, else the kind's default). */
  recipeOf(rec: StructureRecord): RecipeId {
    const kind = rec.kind as StructureKindId;
    if (!isProcessorKind(kind)) throw new Error(`not a processor: ${kind}`);
    const r = rec.recipe;
    return r !== undefined && RECIPES[r].processors.includes(kind) ? r : defaultRecipeFor(kind);
  }

  pulse(): void {
    const procs = this.procs;
    procs.length = 0;
    for (const rec of this.d.registry.all()) if (isProcessorKind(rec.kind)) procs.push(rec);
    const n = procs.length;
    if (n === 0) return;
    const start = this.pulses++ % n;
    this.netComponent = null;
    for (let k = 0; k < n; k++) this.step(procs[(start + k) % n]!);
  }

  /**
   * The owner picks a recipe. A cycle already loaded under the old recipe
   * hands its inputs back to the network first; if they don't fit, the change
   * is refused (returns false) so nothing is lost.
   */
  setRecipe(rec: StructureRecord, recipe: RecipeId): boolean {
    const kind = rec.kind as StructureKindId;
    if (!isProcessorKind(kind) || !RECIPES[recipe].processors.includes(kind)) return false;
    if (this.recipeOf(rec) === recipe) {
      rec.recipe = recipe;
      return true;
    }
    if (rec.prodLoaded === true) {
      this.netComponent = null;
      this.collectNetwork(rec);
      const oldId = this.recipeOf(rec);
      const old = this.effective(rec, oldId);
      if (old !== null && !this.put(inputsAsOutputs(oldId, old))) return false;
      rec.prodLoaded = false;
      rec.prodProgress = 0;
    }
    rec.recipe = recipe;
    return true;
  }

  private step(rec: StructureRecord): void {
    if (!rec.isConstructed) {
      rec.prodState = PROD_STATE.none;
      return;
    }
    const eff = this.effective(rec, this.recipeOf(rec));
    if (eff === null) {
      rec.prodState = PROD_STATE.needsBlueprint;
      return;
    }
    if (!this.d.powered(rec.id)) {
      rec.prodState = PROD_STATE.unpowered;
      return;
    }
    this.collectNetwork(rec);
    if (rec.prodLoaded !== true) {
      const missing = this.firstMissing(eff.inputs);
      if (missing !== undefined) {
        rec.prodState = PROD_STATE.starved;
        rec.prodMissing = missing;
        return;
      }
      this.take(eff.inputs);
      rec.prodLoaded = true;
      rec.prodProgress = 0;
    }
    rec.prodMissing = undefined;
    const progress = rec.prodProgress ?? 0;
    if (progress < eff.cyclePulses) rec.prodProgress = progress + 1;
    if ((rec.prodProgress ?? 0) >= eff.cyclePulses) {
      if (!this.put(eff.outputs)) {
        rec.prodState = PROD_STATE.blocked;
        return;
      }
      rec.prodLoaded = false;
      rec.prodProgress = 0;
      this.cyclesCompleted++;
    }
    rec.prodState = PROD_STATE.running;
  }

  /** Base or blueprint-scaled recipe; null when a needed blueprint is missing. */
  private effective(rec: StructureRecord, id: RecipeId): EffectiveRecipe | null {
    const def = RECIPES[id];
    if (def.blueprintRequired && this.d.blueprintFor) return this.d.blueprintFor(rec, id);
    return def;
  }

  /** Same-owner operational storage in the processor's grid component. */
  private collectNetwork(rec: StructureRecord): void {
    const comp = this.d.componentOf(rec.id);
    if (comp === this.netComponent && rec.owner === this.netOwner) return;
    this.netComponent = comp;
    this.netOwner = rec.owner;
    const net = this.net;
    net.length = 0;
    for (const id of comp) {
      const s = this.d.registry.get(id);
      if (s && s.owner === rec.owner && isOperationalStorage(s)) net.push(s);
    }
  }

  private available(g: GoodId): number {
    let n = 0;
    for (const s of this.net) {
      n += s.hold?.goods[g] ?? 0;
      if (g === 'minerals') n += s.minerals;
    }
    return n;
  }

  private firstMissing(inputs: Readonly<Partial<Record<GoodId, number>>>): GoodId | undefined {
    for (const g of GOOD_IDS) {
      const need = inputs[g] ?? 0;
      if (need > 0 && this.available(g) < need) return g;
    }
    return undefined;
  }

  /** Take exactly `inputs` (checked available first): holds, then the bank. */
  private take(inputs: Readonly<Partial<Record<GoodId, number>>>): void {
    for (const g of GOOD_IDS) {
      let need = inputs[g] ?? 0;
      if (need <= 0) continue;
      for (const s of this.net) {
        if (need <= 0) break;
        const have = s.hold?.goods[g] ?? 0;
        if (have > 0) {
          const t = Math.min(have, need);
          if (have - t > 0) s.hold!.goods[g] = have - t;
          else delete s.hold!.goods[g];
          need -= t;
        }
        if (g === 'minerals' && need > 0 && s.minerals > 0) {
          const t = Math.min(s.minerals, need);
          s.minerals -= t;
          need -= t;
        }
      }
    }
  }

  /**
   * Put exactly `outputs` into the network, or nothing. Minerals fill a
   * Capital bank first; goods fill holds by weight. Placement is planned before
   * anything is written, so a partial fit changes nothing.
   */
  private put(outputs: readonly RecipeOutput[]): boolean {
    const net = this.net;
    const free = this.free;
    free.length = net.length;
    for (let i = 0; i < net.length; i++) free[i] = NaN; // weighed lazily
    // Plan: check every unit fits somewhere before writing anything. Most
    // outputs fit in the first storage, so most storages are never weighed.
    let bankPlanned = 0;
    for (const o of outputs) {
      if (!('good' in o)) continue;
      let n = o.n;
      if (o.good === 'minerals') {
        let bankFree = 0;
        for (const s of net) bankFree += Math.max(0, getStructureKind(s.kind).storageCapacity - s.minerals);
        const b = Math.min(n, bankFree - bankPlanned);
        bankPlanned += b;
        n -= b;
      }
      const w = GOOD_DEFS[o.good].weight;
      for (let i = 0; i < net.length && n > 0; i++) {
        if (Number.isNaN(free[i]!)) free[i] = holdCapacityOf(net[i]!) - holdWeightOf(net[i]!);
        const fit = Math.min(n, Math.floor((free[i]! + 1e-9) / w));
        free[i]! -= fit * w;
        n -= fit;
      }
      if (n > 0) return false;
    }
    // Apply, in the same order as the plan.
    for (let i = 0; i < net.length; i++) free[i] = NaN;
    for (const o of outputs) {
      if (!('good' in o)) continue;
      let n = o.n;
      if (o.good === 'minerals') {
        for (const s of net) {
          if (n <= 0) break;
          const b = Math.min(n, Math.max(0, getStructureKind(s.kind).storageCapacity - s.minerals));
          s.minerals += b;
          n -= b;
        }
      }
      const w = GOOD_DEFS[o.good].weight;
      for (let i = 0; i < net.length && n > 0; i++) {
        const s = net[i]!;
        if (Number.isNaN(free[i]!)) free[i] = holdCapacityOf(s) - holdWeightOf(s);
        const fit = Math.min(n, Math.floor((free[i]! + 1e-9) / w));
        if (fit <= 0) continue;
        s.hold ??= { goods: {}, blueprints: [] };
        s.hold.goods[o.good] = (s.hold.goods[o.good] ?? 0) + fit;
        free[i]! -= fit * w;
        n -= fit;
      }
    }
    return true;
  }
}

function holdWeightOf(s: StructureRecord): number {
  let w = 0;
  const goods = s.hold?.goods;
  if (!goods) return 0;
  for (const g of GOOD_IDS) w += (goods[g] ?? 0) * GOOD_DEFS[g].weight;
  return w;
}

/** A recipe's inputs as outputs (handing a loaded cycle back), cached per
 *  recipe for base values so steady state allocates nothing. */
const INPUTS_AS_OUTPUTS = new Map<RecipeId, readonly RecipeOutput[]>();
function inputsAsOutputs(id: RecipeId, eff: EffectiveRecipe): readonly RecipeOutput[] {
  if (eff === RECIPES[id]) {
    let c = INPUTS_AS_OUTPUTS.get(id);
    if (!c) {
      c = Object.entries(eff.inputs).map(([good, n]) => ({ good: good as GoodId, n: n ?? 0 }));
      INPUTS_AS_OUTPUTS.set(id, c);
    }
    return c;
  }
  return Object.entries(eff.inputs).map(([good, n]) => ({ good: good as GoodId, n: n ?? 0 }));
}
