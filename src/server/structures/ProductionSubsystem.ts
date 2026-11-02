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
 * **Blueprints** (Living World W2). A recipe with `blueprintRequired` runs only
 * with a matching blueprint in the processor's slot (`rec.blueprint`):
 * `applyBlueprint` trims the inputs (material efficiency), a copy spends one run
 * per cycle (a used-up copy leaves the slot), output quality gives a chance of
 * one extra unit per output (rolled deterministically per processor and cycle),
 * and a packed structure carries the quality. `onBlueprintSpent` lets the room
 * persist the slot.
 *
 * Storage holds are mutated in place, exactly like mining and construction do
 * with the Capital bank; `StorageService.flushDirty()` persists them on the
 * same pulse. A cycle's inputs are consumed when it starts, so a processor never
 * makes value from nothing.
 *
 * Allocation: the processor and network lists are reused arrays and blueprint
 * effects are cached per slot; steady-state pulses allocate nothing (#14).
 */
import { GOOD_DEFS, GOOD_IDS, type GoodId } from '../../shared-types/goods.js';
import { RECIPES, blueprintProductFor, type RecipeId, type RecipeOutput } from '../../shared-types/recipes.js';
import { PROD_STATE, defaultRecipeFor, isProcessorKind } from '../../shared-types/production.js';
import { getStructureKind, type StructureKindId } from '../../shared-types/structureKinds.js';
import { applyBlueprint, isBlueprintUsedUp, spendBlueprintRun, type AppliedRecipe } from '../../shared-types/blueprints.js';
import type { BlueprintItem } from '../../shared-types/items.js';
import { addPacked, holdWeight, packedWeightOf } from '../../core/cargo/hold.js';
import { holdCapacityOf, isOperationalStorage } from '../cargo/StorageService.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';

/** What one cycle of a recipe actually uses and makes. */
export interface EffectiveRecipe {
  inputs: Readonly<Partial<Record<GoodId, number>>>;
  outputs: readonly RecipeOutput[];
  cyclePulses: number;
  /** Chance of one extra unit of each goods output (blueprint quality). */
  yieldBonus: number;
  /** Quality stamped onto a packed output. */
  quality: number;
}

export interface ProductionDeps {
  registry: StructureRegistry;
  /** Battery-backed power for a structure's component. */
  powered(id: string): boolean;
  /** Ids in the same grid component as `id` (including `id`). */
  componentOf(id: string): readonly string[];
  /** A processor's blueprint changed (a run was spent, or a used-up copy left
   *  the slot): persist the slot. */
  onBlueprintSpent?(rec: StructureRecord): void;
  /** Active power: full draw while running, the idle trickle otherwise. */
  setActive?(rec: StructureRecord, active: boolean): void;
  /** D3 — a city module finished a cycle: pay its owner `n` credits (taxes).
   *  The room pays a player's wallet; an NPC owner has none. */
  payCredits?(rec: StructureRecord, n: number): void;
}

interface AppliedCache {
  bp: BlueprintItem;
  recipe: RecipeId;
  material: number;
  output: number;
  eff: EffectiveRecipe;
}

/** `structure:<kind>` product ids, built once per kind (no per-cycle strings). */
const PACKED_PRODUCT = new Map<StructureKindId, string>();
function packedProduct(kind: StructureKindId): string {
  let p = PACKED_PRODUCT.get(kind);
  if (p === undefined) {
    p = `structure:${kind}`;
    PACKED_PRODUCT.set(kind, p);
  }
  return p;
}

/** `hull:<kind>` product ids, built once per kind. */
const HULL_PRODUCT = new Map<string, string>();
function hullProduct(kind: string): string {
  let p = HULL_PRODUCT.get(kind);
  if (p === undefined) {
    p = `hull:${kind}`;
    HULL_PRODUCT.set(kind, p);
  }
  return p;
}

/** A recipe's base effect (no blueprint), cached per recipe. */
const BASE_EFFECT = new Map<RecipeId, EffectiveRecipe>();
function baseEffect(id: RecipeId): EffectiveRecipe {
  let e = BASE_EFFECT.get(id);
  if (e === undefined) {
    const d = RECIPES[id];
    e = { inputs: d.inputs, outputs: d.outputs, cyclePulses: d.cyclePulses, yieldBonus: 0, quality: 0 };
    BASE_EFFECT.set(id, e);
  }
  return e;
}

export class ProductionSubsystem {
  private readonly procs: StructureRecord[] = [];
  private readonly net: StructureRecord[] = [];
  private readonly free: number[] = [];
  private readonly bank: number[] = [];
  /** The network last collected (component array + owner): processors in the
   *  same component reuse it, so a pulse scans each component once. Reset by
   *  `pulse()` (storage may have been built or removed since). */
  private netComponent: readonly string[] | null = null;
  private netOwner = '';
  private pulses = 0;
  private readonly applied = new Map<string, AppliedCache>();
  private readonly idHash = new Map<string, number>();
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
    this.burnFuel();
    const procs = this.procs;
    procs.length = 0;
    for (const rec of this.d.registry.all()) if (isProcessorKind(rec.kind)) procs.push(rec);
    const n = procs.length;
    if (n === 0) return;
    const start = this.pulses++ % n;
    this.netComponent = null;
    for (let k = 0; k < n; k++) {
      const rec = procs[(start + k) % n]!;
      this.step(rec);
      this.d.setActive?.(rec, rec.prodState === PROD_STATE.running);
    }
  }

  /**
   * D1 — each built Reactor burns ONE unit of fuel from its network every
   * `fuelEveryPulses` pulses; without fuel it stops producing power. A change
   * in fuelled state marks the grid topology dirty so power is recomputed.
   */
  private burnFuel(): void {
    for (const rec of this.d.registry.all()) {
      const every = getStructureKind(rec.kind).fuelEveryPulses;
      if (every == null || !rec.isConstructed) continue;
      const before = rec.fueled === true;
      const t = (rec.fuelTimer ?? 0) - 1;
      if (t > 0) {
        rec.fuelTimer = t;
        continue;
      }
      const ok = this.takeGoods(rec, ONE_FUEL);
      rec.fueled = ok;
      rec.fuelTimer = ok ? every : 0;
      if (ok !== before) this.d.registry.topologyDirty = true;
    }
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
    if (rec.prodLoaded === true && !this.unload(rec)) return false;
    rec.recipe = recipe;
    return true;
  }

  /**
   * Hand a loaded cycle's inputs back to the network (before the recipe or the
   * blueprint changes). Returns false, changing nothing, if they don't fit.
   */
  unload(rec: StructureRecord): boolean {
    if (rec.prodLoaded !== true) return true;
    this.netComponent = null;
    this.collectNetwork(rec);
    const id = this.recipeOf(rec);
    const eff = this.effective(rec, id) ?? baseEffect(id);
    if (!this.put(inputsAsOutputs(eff), 0, 0)) return false;
    rec.prodLoaded = false;
    rec.prodProgress = 0;
    return true;
  }

  /**
   * P2c — put `n` of a good into `rec`'s owner network storage (extractors:
   * ice and crystal from Miners, gas from Gas Collectors). All or nothing;
   * returns what was stored.
   */
  deposit(rec: StructureRecord, good: GoodId, n: number): number {
    if (n <= 0) return 0;
    this.netComponent = null;
    this.collectNetwork(rec);
    const out = this.depositScratch;
    out.good = good;
    out.n = n;
    return this.put(this.depositList, 0, 0) ? n : 0;
  }
  /** P2d — take exactly `inputs` from `rec`'s owner network storage (all
   *  or nothing). Turrets use it for munitions. */
  takeGoods(rec: StructureRecord, inputs: Readonly<Partial<Record<GoodId, number>>>): boolean {
    this.netComponent = null;
    this.collectNetwork(rec);
    if (this.firstMissing(inputs) !== undefined) return false;
    this.take(inputs);
    return true;
  }

  private readonly depositScratch: { good: GoodId; n: number } = { good: 'minerals', n: 0 };
  private readonly depositList: readonly RecipeOutput[] = [this.depositScratch];

  private step(rec: StructureRecord): void {
    if (!rec.isConstructed) {
      rec.prodState = PROD_STATE.none;
      return;
    }
    const id = this.recipeOf(rec);
    const loaded = rec.prodLoaded === true;
    // A loaded cycle keeps running on what it captured at its start, even if
    // the copy that started it is now used up.
    const eff = loaded ? this.effective(rec, id) ?? baseEffect(id) : this.effective(rec, id);
    if (eff === null) {
      rec.prodState = PROD_STATE.needsBlueprint;
      return;
    }
    if (!this.d.powered(rec.id)) {
      rec.prodState = PROD_STATE.unpowered;
      return;
    }
    this.collectNetwork(rec);
    if (!loaded) {
      const missing = this.firstMissing(eff.inputs);
      if (missing !== undefined) {
        rec.prodState = PROD_STATE.starved;
        rec.prodMissing = missing;
        return;
      }
      this.take(eff.inputs);
      rec.prodLoaded = true;
      rec.prodProgress = 0;
      rec.prodQuality = eff.quality;
      rec.prodYield = eff.yieldBonus;
      if (RECIPES[id].blueprintRequired && rec.blueprint !== undefined) {
        spendBlueprintRun(rec.blueprint);
        if (isBlueprintUsedUp(rec.blueprint)) {
          rec.blueprint = undefined;
          this.applied.delete(rec.id);
        }
        this.d.onBlueprintSpent?.(rec);
      }
    }
    rec.prodMissing = undefined;
    const progress = rec.prodProgress ?? 0;
    if (progress < eff.cyclePulses) rec.prodProgress = progress + 1;
    if ((rec.prodProgress ?? 0) >= eff.cyclePulses) {
      const cycle = rec.prodCycles ?? 0;
      const extra = (rec.prodYield ?? 0) > 0 && this.roll(rec.id, cycle) < (rec.prodYield ?? 0) ? 1 : 0;
      if (!this.put(eff.outputs, extra, rec.prodQuality ?? 0)) {
        rec.prodState = PROD_STATE.blocked;
        return;
      }
      rec.prodLoaded = false;
      rec.prodProgress = 0;
      rec.prodCycles = cycle + 1;
      this.cyclesCompleted++;
      // D3 — taxes go to the owner's wallet, never into a hold.
      for (const o of eff.outputs) if ('credits' in o) this.d.payCredits?.(rec, o.credits);
    }
    rec.prodState = PROD_STATE.running;
  }

  /** Base effect, or the slot blueprint's (cached); null when a needed
   *  blueprint is missing, used up, or for another product. */
  private effective(rec: StructureRecord, id: RecipeId): EffectiveRecipe | null {
    const def = RECIPES[id];
    if (!def.blueprintRequired) return baseEffect(id);
    const bp = rec.blueprint;
    if (bp === undefined || isBlueprintUsedUp(bp) || bp.product !== blueprintProductFor(id)) return null;
    const c = this.applied.get(rec.id);
    if (c !== undefined && c.bp === bp && c.recipe === id && c.material === bp.material && c.output === bp.output) return c.eff;
    const a: AppliedRecipe<readonly RecipeOutput[]> = applyBlueprint(def, bp);
    const eff: EffectiveRecipe = { inputs: a.inputs, outputs: a.outputs, cyclePulses: a.cyclePulses, yieldBonus: a.yieldBonus, quality: a.quality };
    this.applied.set(rec.id, { bp, recipe: id, material: bp.material, output: bp.output, eff });
    return eff;
  }

  /** A deterministic roll in [0, 1) per processor and cycle (the yield bonus). */
  private roll(id: string, cycle: number): number {
    let h = this.idHash.get(id);
    if (h === undefined) {
      h = 2166136261;
      for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
      this.idHash.set(id, h);
    }
    let x = Math.imul(h ^ Math.imul(cycle + 1, 0x9e3779b1), 0x85ebca6b);
    x ^= x >>> 13;
    x = Math.imul(x, 0xc2b2ae35);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
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
   * Put exactly `outputs` (+`extra` units of each goods output) into the
   * network, or nothing. Minerals fill a Capital bank first; goods and packed
   * structures fill holds by weight. Placement is planned before anything is
   * written, so a partial fit changes nothing. Storages are weighed lazily.
   */
  private put(outputs: readonly RecipeOutput[], extra: number, quality: number): boolean {
    if (!this.placeAll(outputs, extra, false, quality)) return false;
    this.placeAll(outputs, extra, true, quality);
    return true;
  }

  private placeAll(outputs: readonly RecipeOutput[], extra: number, apply: boolean, quality: number): boolean {
    const net = this.net;
    const free = this.free;
    const bank = this.bank;
    free.length = net.length;
    bank.length = net.length;
    for (let i = 0; i < net.length; i++) {
      free[i] = NaN; // weighed lazily
      bank[i] = NaN;
    }
    for (const o of outputs) {
      if ('credits' in o) continue; // D3 taxes: paid to the wallet, take no space
      if ('packed' in o || 'hull' in o) {
        // A packed structure, or a packed hull (W5 Shipyard): one discrete item.
        const product = 'packed' in o ? packedProduct(o.packed) : hullProduct(o.hull);
        const w = packedWeightOf(product);
        let placed = false;
        for (let i = 0; i < net.length && !placed; i++) {
          if (Number.isNaN(free[i]!)) free[i] = holdCapacityOf(net[i]!) - holdWeight(net[i]!.hold ?? EMPTY);
          if (free[i]! + 1e-9 < w) continue;
          free[i]! -= w;
          placed = true;
          if (apply) addPacked((net[i]!.hold ??= { goods: {}, blueprints: [] }), product, quality);
        }
        if (!placed) return false;
        continue;
      }
      let n = o.n + extra;
      if (o.good === 'minerals') {
        for (let i = 0; i < net.length && n > 0; i++) {
          const s = net[i]!;
          if (Number.isNaN(bank[i]!)) bank[i] = Math.max(0, getStructureKind(s.kind).storageCapacity - s.minerals);
          const b = Math.min(n, bank[i]!);
          bank[i]! -= b;
          if (apply) s.minerals += b;
          n -= b;
        }
      }
      const w = GOOD_DEFS[o.good].weight;
      for (let i = 0; i < net.length && n > 0; i++) {
        const s = net[i]!;
        if (Number.isNaN(free[i]!)) free[i] = holdCapacityOf(s) - holdWeight(s.hold ?? EMPTY);
        const fit = Math.min(n, Math.floor((free[i]! + 1e-9) / w));
        if (fit <= 0) continue;
        if (apply) {
          s.hold ??= { goods: {}, blueprints: [] };
          s.hold.goods[o.good] = (s.hold.goods[o.good] ?? 0) + fit;
        }
        free[i]! -= fit * w;
        n -= fit;
      }
      if (n > 0) return false;
    }
    return true;
  }
}

const EMPTY = { goods: {}, blueprints: [] };
const ONE_FUEL: Readonly<Partial<Record<GoodId, number>>> = Object.freeze({ fuel: 1 });

/** A cycle's inputs as outputs (handing a loaded cycle back). Rare (recipe or
 *  blueprint change), so it may allocate. */
function inputsAsOutputs(eff: EffectiveRecipe): readonly RecipeOutput[] {
  return Object.entries(eff.inputs).map(([good, n]) => ({ good: good as GoodId, n: n ?? 0 }));
}
