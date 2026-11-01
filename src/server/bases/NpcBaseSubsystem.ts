/**
 * NPC bases built from real structures (plan soft-leaping-truffle v3, D2).
 *
 * Grows a base with the core generator (`growBase`) and seeds it into the room:
 *  - every structure is placed through the real `StructurePlacementSubsystem`
 *    (`skipAutoConnect`: the generator supplies the intended graph, so greedy
 *    auto-connect can't, e.g., close a gate), owned by `npc:<side>:<baseId>`;
 *  - the generator's edges are applied with `connectExplicit` (the real
 *    `canConnect` re-checked against the live adjacency);
 *  - everything spawns BUILT at its generated level (HP at the leveled max);
 *  - processors get their recipe and, where the recipe needs one, a BOUND
 *    faction blueprint (it can't be unloaded, so a break-in can't steal an
 *    infinite original);
 *  - gates open for anyone not hostile (civilian bases);
 *  - storage is stocked so the base runs from the start: an hour of Reactor
 *    fuel, munitions for ammo turrets, and inputs for its processors.
 *
 * Then the real systems run: power, batteries, fence, turrets, production.
 * NPC structures are not persisted (B2); a restart regenerates from the seed.
 */
import { growBase, type GrownBase } from '../../core/bases/growBase.js';
import { TIER_LEVEL_CAP, TIER_WEALTH, type BaseProfile, type BaseRole, type BaseTier } from '../../core/bases/baseProfile.js';
import type { SectorFeature } from '../../core/galaxy/galaxy.js';
import { effectiveStructureMaxHealth } from '../../core/leveling/structureLevel.js';
import { npcOwner } from '../../shared-types/relations.js';
import { gateAccessIndex } from '../../shared-types/gateAccess.js';
import { getStructureKind, type StructureKindId } from '../../shared-types/structureKinds.js';
import { GOOD_DEFS, type GoodId } from '../../shared-types/goods.js';
import { RECIPES, blueprintProductFor } from '../../shared-types/recipes.js';
import { usesAmmo } from '../../shared-types/ammo.js';
import type { NpcAllegianceId } from '../../shared-types/allegiances.js';
import { gateTypeOf } from '../../core/structures/gateGeometry.js';
import { buildGridNodes, connectExplicit } from '../structures/structureGridView.js';
import type { StructureRecord, StructureRegistry } from '../structures/StructureRegistry.js';

export interface NpcBaseSpec {
  /** Stable id within the sector (part of the owner string). */
  baseId: string;
  role: BaseRole;
  tier: BaseTier;
  seed: number;
  /** World position of the base's Capital. */
  x: number;
  y: number;
  side?: NpcAllegianceId;
  features?: SectorFeature[];
  fenced?: boolean;
  /** Override the tier's default wealth. */
  wealth?: number;
  /** T1 — a full profile (a galaxy sector's `baseProfileFor`); overrides the
   *  tier defaults above. */
  profile?: BaseProfile;
}

export interface NpcBaseHooks {
  registry: StructureRegistry;
  /** `StructurePlacementSubsystem.place(owner, kind, x, y, { skipAutoConnect: true, rot })`. */
  place(owner: string, kind: StructureKindId, x: number, y: number, rot: number): string | null;
  setHealth(id: string, hp: number): void;
}

export interface SeededNpcBase {
  owner: string;
  grown: GrownBase;
  placed: number;
  rejectedPlace: number;
  rejectedEdge: number;
}

/** Ops kill switch for galaxy NPC bases (T1): `EQX_DISABLE_NPC_BASES=1`.
 *  Test rooms with an explicit `npcBases` option are unaffected. */
export function isNpcBasesDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env['EQX_DISABLE_NPC_BASES'];
  return v === '1' || v === 'true';
}

/** Hours of fuel a base starts with (pulses at 1 Hz). */
const START_FUEL_PULSES = 3600;
/** Processor cycles of inputs a base starts with. */
const START_INPUT_CYCLES = 20;
/** Munitions per ammo turret at the start. */
const START_MUNITIONS_PER_TURRET = 10;

export class NpcBaseSubsystem {
  constructor(private readonly h: NpcBaseHooks) {}

  /** The profile a spec describes (its `profile`, else the tier defaults). */
  profileOf(spec: NpcBaseSpec): BaseProfile {
    if (spec.profile) return spec.profile;
    const [w0, w1] = TIER_WEALTH[spec.tier];
    const [, l1] = TIER_LEVEL_CAP[spec.tier];
    return {
      tier: spec.tier,
      role: spec.role,
      ownerSide: spec.side ?? 'traders',
      wealth: spec.wealth ?? Math.round((w0 + w1) / 2),
      levelCap: l1,
      fenced: spec.fenced ?? true,
    };
  }

  /** Grow the base a spec describes (pure; nothing placed). Lets a caller
   *  pick a site from its extent before seeding (T1). */
  grow(spec: NpcBaseSpec): GrownBase {
    return growBase(this.profileOf(spec), spec.seed, spec.features ?? []);
  }

  /** Place a base with its Capital at (spec.x, spec.y). `grown` may come from
   *  `grow(spec)`; otherwise it is grown here. */
  seed(spec: NpcBaseSpec, grownIn?: GrownBase): SeededNpcBase {
    const profile = this.profileOf(spec);
    const grown = grownIn ?? this.grow(spec);
    const owner = npcOwner(profile.ownerSide, spec.baseId);

    const ids: Array<string | null> = [];
    let rejectedPlace = 0;
    for (const p of grown.placements) {
      const id = this.h.place(owner, p.kind, spec.x + p.x, spec.y + p.y, p.rot ?? 0);
      ids.push(id);
      if (id === null) {
        rejectedPlace++;
        continue;
      }
      const rec = this.h.registry.get(id)!;
      rec.isConstructed = true;
      rec.constructionProgress = rec.constructionCost;
      rec.level = p.level ?? 1;
      this.h.setHealth(id, effectiveStructureMaxHealth(getStructureKind(p.kind).maxHealth, rec.level));
      if (p.recipe) {
        rec.recipe = p.recipe;
        if (RECIPES[p.recipe].blueprintRequired) {
          rec.blueprint = {
            uid: `npc-bp-${spec.baseId}-${id}`,
            product: blueprintProductFor(p.recipe),
            kind: 'bpo',
            runs: null,
            material: Math.min(10, 2 * profile.levelCap),
            output: Math.min(100, 15 * profile.levelCap),
            research: 0,
            bound: true,
          };
        }
      }
      if (gateTypeOf(p.kind) !== null) rec.gateAccess = gateAccessIndex('open');
    }

    const nodes = buildGridNodes(this.h.registry);
    let rejectedEdge = 0;
    for (const [a, b] of grown.edges) {
      const ia = ids[a], ib = ids[b];
      if (!ia || !ib || !connectExplicit(this.h.registry, ia, ib, nodes)) rejectedEdge++;
    }
    this.h.registry.topologyDirty = true;
    this.stock(ids.filter((i): i is string => i !== null).map((i) => this.h.registry.get(i)!));
    return { owner, grown, placed: grown.placements.length - rejectedPlace, rejectedPlace, rejectedEdge };
  }

  /** Fill the base's storage with what it needs to run from the start. */
  private stock(recs: StructureRecord[]): void {
    const want = new Map<GoodId, number>();
    const add = (g: GoodId, n: number) => want.set(g, (want.get(g) ?? 0) + n);
    for (const r of recs) {
      const k = getStructureKind(r.kind);
      if (k.fuelEveryPulses) add('fuel', Math.ceil(START_FUEL_PULSES / k.fuelEveryPulses));
      if (usesAmmo(r.kind)) add('munitions', START_MUNITIONS_PER_TURRET);
      if (r.recipe) for (const [g, n] of Object.entries(RECIPES[r.recipe].inputs)) add(g as GoodId, (n ?? 0) * START_INPUT_CYCLES);
    }
    const storage = recs.filter((r) => (getStructureKind(r.kind).holdCapacity ?? 0) > 0);
    for (const [g, total] of want) {
      let left = total;
      if (g === 'minerals') {
        for (const s of storage) {
          const room = getStructureKind(s.kind).storageCapacity - s.minerals;
          const b = Math.max(0, Math.min(left, room));
          s.minerals += b;
          left -= b;
        }
      }
      const w = GOOD_DEFS[g].weight;
      for (const s of storage) {
        if (left <= 0) break;
        s.hold ??= { goods: {}, blueprints: [] };
        let used = 0;
        for (const [gg, n] of Object.entries(s.hold.goods)) used += (n ?? 0) * GOOD_DEFS[gg as GoodId].weight;
        const fit = Math.max(0, Math.floor((getStructureKind(s.kind).holdCapacity! - used) / w));
        const put = Math.min(fit, left);
        if (put > 0) s.hold.goods[g] = (s.hold.goods[g] ?? 0) + put;
        left -= put;
      }
    }
  }
}
