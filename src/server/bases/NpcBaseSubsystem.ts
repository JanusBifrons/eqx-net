/**
 * NPC bases built from real structures (plan soft-leaping-truffle v3, D2).
 *
 * Grows a base with the core generator (`growBase`) and seeds it into the room:
 *  - every structure is placed through the real `StructurePlacementSubsystem`
 *    (`skipAutoConnect`: the generator supplies the intended graph, so greedy
 *    auto-connect can't, e.g., close a gate), owned by `npc:<faction>:<baseId>`;
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
 * Each piece records its `originBase`; a base that fell (its pieces saved as
 * `none:` or captured) is never seeded again (capture 4E S6).
 */
import { DEFAULT_TELEPORT_RULES, NPC_LINK_TOLL, isTeleporterKind } from '../../shared-types/teleport.js';
import { growBase, type GrownBase } from '../../core/bases/growBase.js';
import { deckBaseOriginInto } from '../../core/bases/growDeck.js';
import { TIER_LEVEL_CAP, TIER_WEALTH, type BaseProfile, type BaseRole, type BaseTier } from '../../core/bases/baseProfile.js';
import type { SectorFeature } from '../../core/galaxy/galaxy.js';
import { effectiveStructureMaxHealth } from '../../core/leveling/structureLevel.js';
import { npcOwner } from '../../shared-types/relations.js';
import { gateAccessIndex } from '../../shared-types/gateAccess.js';
import { getStructureKind, type StructureKindId } from '../../shared-types/structureKinds.js';
import { GOOD_DEFS, type GoodId } from '../../shared-types/goods.js';
import { RECIPES, blueprintProductFor } from '../../shared-types/recipes.js';
import { usesAmmo } from '../../shared-types/ammo.js';
import type { FactionId } from '../../shared-types/factions.js';
import { gateTypeOf } from '../../core/structures/gateGeometry.js';
import { buildGridNodes, connectExplicit } from '../structures/structureGridView.js';
import { fallenBaseOrigins } from '../structures/ownerlessBase.js';
import type { GridObstacle, ObstacleBox } from '../../core/structures/Grid.js';
import type { StructureRecord, StructureRegistry } from '../structures/StructureRegistry.js';
import type { Logger } from 'pino';
import { chooseBaseSite, grownExtent, type SiteBox, type SiteCircle } from '../../core/bases/baseSite.js';
import { galaxyBasePlan, type GalaxyBasePlan } from '../../core/bases/galaxyBases.js';
import { getSector } from '../../core/galaxy/galaxy.js';
import { pocketClearing, sectorSites } from '../../core/galaxy/sectorSites.js';
import { HOME_POCKET_HALF_EXTENT, SOLAR_SECTORS, sectorSpace } from '../../shared-types/sectorBounds.js';
import { SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { StructurePlacementSubsystem } from '../structures/StructurePlacementSubsystem.js';
import type { PatrolSubsystem } from './PatrolSubsystem.js';

export interface NpcBaseSpec {
  /** Stable id within the sector (part of the owner string). */
  baseId: string;
  role: BaseRole;
  tier: BaseTier;
  seed: number;
  /** World position of the base's Capital. */
  x: number;
  y: number;
  side?: FactionId;
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
  /** The room's `getObstacles(near)`: asteroids plus the dormant cut-field
   *  rocks reaching `near` (macro terrain C5g). A generated edge whose line
   *  crosses one is rejected, as a player's link is. */
  getObstacles?(near: ObstacleBox): readonly GridObstacle[];
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
      ownerFaction: spec.side ?? 'traders',
      wealth: spec.wealth ?? Math.round((w0 + w1) / 2),
      levelCap: l1,
      fenced: spec.fenced ?? true,
    };
  }

  /** Grow the base a spec describes (pure; nothing placed). Lets a caller
   *  pick a site from its extent before seeding (T1). On a deck room
   *  (`registry.deck`, base platforms) the base is grown on plates. */
  grow(spec: NpcBaseSpec): GrownBase {
    return growBase(this.profileOf(spec), spec.seed, spec.features ?? [], this.h.registry.deck ? { deck: true } : {});
  }

  /** Place a base with its Capital (a deck base: its origin plate) at (spec.x, spec.y). `grown` may come from
   *  `grow(spec)`; otherwise it is grown here. */
  seed(spec: NpcBaseSpec, grownIn?: GrownBase): SeededNpcBase {
    const profile = this.profileOf(spec);
    const grown = grownIn ?? this.grow(spec);
    const owner = npcOwner(profile.ownerFaction, spec.baseId);
    // A deck base is grown round its origin plate: seed it on the nearest
    // plate centre, so its plates sit on the world's deck lattice.
    const at = this.h.registry.deck ? deckBaseOriginInto(spec.x, spec.y, { x: 0, y: 0 }) : spec;

    const ids: Array<string | null> = [];
    let rejectedPlace = 0;
    for (const p of grown.placements) {
      const id = this.h.place(owner, p.kind, at.x + p.x, at.y + p.y, p.rot ?? 0);
      ids.push(id);
      if (id === null) {
        rejectedPlace++;
        continue;
      }
      const rec = this.h.registry.get(id)!;
      rec.originBase = owner; // 4E S6: a fallen base is known by its origin
      rec.isConstructed = true;
      rec.constructionProgress = rec.constructionCost;
      rec.level = p.level ?? 1;
      this.h.setHealth(id, effectiveStructureMaxHealth(getStructureKind(p.kind).maxHealth, rec.level));
      // An established base has charged batteries: they carry its fence
      // through a fight or a production spike from the first pulse.
      const storeCap = getStructureKind(p.kind).powerStorageCapacity ?? 0;
      if (storeCap > 0) rec.storedPower = storeCap;
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
      // A military base admits only its owner and allies (v4 M).
      if (gateTypeOf(p.kind) !== null) rec.gateAccess = gateAccessIndex(profile.role === 'military' ? 'allies' : 'open');
      // v4 H — a transit link's teleporter: fires when a ship boards, charges
      // the owner's toll; it finds its partner at run time by the link id.
      if (p.link !== undefined && isTeleporterKind(p.kind)) {
        rec.npcLink = p.link;
        rec.tpRules = { ...DEFAULT_TELEPORT_RULES, shipBoards: true };
        rec.tpToll = { ...NPC_LINK_TOLL };
      }
    }

    const nodes = buildGridNodes(this.h.registry);
    // One obstacle query over the placed centres: every edge runs centre to
    // centre inside this box, so any rock that can cut one reaches it.
    let obstacles: readonly GridObstacle[] | undefined;
    if (this.h.getObstacles) {
      const box: ObstacleBox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const id of ids) {
        const r = id ? this.h.registry.get(id) : undefined;
        if (!r) continue;
        box.x0 = Math.min(box.x0, r.x); box.y0 = Math.min(box.y0, r.y);
        box.x1 = Math.max(box.x1, r.x); box.y1 = Math.max(box.y1, r.y);
      }
      if (box.x0 <= box.x1) obstacles = this.h.getObstacles(box);
    }
    let rejectedEdge = 0;
    for (const [a, b] of grown.edges) {
      const ia = ids[a], ib = ids[b];
      if (!ia || !ib || !connectExplicit(this.h.registry, ia, ib, nodes, obstacles)) rejectedEdge++;
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

// ── Boot seeding (moved verbatim from SectorRoom) ──────────────────────────

/** Clear space kept between two NPC bases in one sector (bastions, mines, traffic). */
const NPC_BASE_GAP = sectorSpace(900);

/** What the boot seeders need from the room; getters read fields the room
 *  assigns in `onCreate`. Built once on the room (`npcSeedHost`). */
export interface NpcBaseSeedHost {
  readonly structureRegistry: StructureRegistry;
  readonly swarmRegistry: Pick<SwarmEntityRegistry, 'all'>;
  readonly lingeringPoseCache: ReadonlyMap<string, { x: number; y: number }>;
  readonly patrols: Pick<PatrolSubsystem, 'addBase' | 'watchBaseFalls'>;
  readonly obstacles: { rocks(near?: ObstacleBox): GridObstacle[] };
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  sabF32(): Float32Array;
  structurePlacement(): Pick<StructurePlacementSubsystem, 'place'>;
  swarmHealth(): Pick<Map<string, number>, 'set'>;
  sectorKey(): string | null;
  evictSwarmEntity(rec: SwarmEntityRecord, opts: { broadcast: boolean; emitDestroyed: boolean }): void;
  structureGridTick(): void;
}

/**
 * T1 — grow this galaxy sector's NPC base from its profile and seed it at a
 * site that fits: clear of saved player structures and parked hulls (they
 * always win the space), on the fewest asteroids (those under the footprint
 * are cleared: the builders cleared the rock), as far from the spawn at the
 * origin as it fits. Not persisted: a restart regrows it from the seed,
 * unless it fell (capture 4E S6: the sector's saved `fallenBases`, and its
 * saved pieces carry `originBase`).
 */
export function seedGalaxyBase(h: NpcBaseSeedHost, sectorKey: string): void {
  // A sector holds one to three NPC bases (galaxyBasePlan); base 0 is the
  // sector's original base. Each later one keeps well clear of the earlier.
  const sector = getSector(sectorKey)!;
  const sub = new NpcBaseSubsystem({
    registry: h.structureRegistry,
    place: (owner, kind, x, y, rot) => h.structurePlacement().place(owner, kind, x, y, { skipAutoConnect: true, rot }),
    setHealth: (id, hp) => h.swarmHealth().set(id, hp),
    getObstacles: (near) => h.obstacles.rocks(near),
  });
  const seededBases: SiteBox[] = [];
  // Capture 4E (S6) — a fallen (or captured) base never regrows.
  const fallen = fallenBaseOrigins(h.structureRegistry);
  const plans = galaxyBasePlan(sectorKey);
  // Solar-system sectors (Phase 4): with two or more bases, the last grows
  // at the sector's outer base pocket, out in the system, not at home.
  const outer = SOLAR_SECTORS && plans.length >= 2 ? sectorSites(sectorKey).find((s) => s.kind === 'base') ?? null : null;
  plans.forEach((plan, i) => {
    if (fallen.has(npcOwner(plan.profile.ownerFaction, plan.baseId))) {
      h.logger.info({ sectorKey, baseId: plan.baseId }, 'npc base: fallen, not regrown');
      return;
    }
    const at = outer && i === plans.length - 1 ? { x: outer.x, y: outer.y } : null;
    const box = seedOneGalaxyBase(h, sectorKey, sector.features, plan, sub, seededBases, at);
    if (box !== null) seededBases.push(box);
  });
  h.structureGridTick();
}

/** Seed one planned galaxy base; returns its footprint box, inflated by the
 *  gap a later base must keep, or null when no site fits. */
function seedOneGalaxyBase(
  h: NpcBaseSeedHost,
  sectorKey: string,
  features: readonly SectorFeature[],
  plan: GalaxyBasePlan,
  sub: NpcBaseSubsystem,
  seededBases: readonly SiteBox[],
  /** Grow round this point instead of in the home pocket (outer base pocket). */
  at: { x: number; y: number } | null = null,
): SiteBox | null {
  const { seed, profile } = plan;
  const spec: NpcBaseSpec = {
    baseId: plan.baseId, role: profile.role, tier: profile.tier, seed, x: 0, y: 0,
    side: profile.ownerFaction, features: [...features], profile,
  };
  const grown = sub.grow(spec);
  const hard: SiteBox[] = [...seededBases];
  for (const r of h.structureRegistry.all()) hard.push({ x: r.x, y: r.y, hw: r.halfW ?? r.radius, hh: r.halfH ?? r.radius });
  for (const p of h.lingeringPoseCache.values()) hard.push({ x: p.x, y: p.y, hw: 150, hh: 150 });
  const rocks: SwarmEntityRecord[] = [];
  const soft: SiteCircle[] = [];
  for (const rec of h.swarmRegistry.all()) {
    if (rec.kind !== 0) continue;
    const b = slotBase(rec.slot);
    rocks.push(rec);
    soft.push({ x: h.sabF32()[b + SLOT_X_OFF]!, y: h.sabF32()[b + SLOT_Y_OFF]!, r: rec.radius });
  }
  const ext = grownExtent(grown.placements);
  // In a cut field the base also stays inside its pocket's rock-free
  // clearing (the square's corners reach past the outer pocket's rim).
  const clearing = pocketClearing(sectorKey, SOLAR_SECTORS, at?.x ?? 0, at?.y ?? 0);
  const site = chooseBaseSite(ext, hard, soft, {
    // The home pocket (today's whole sector; the same bound when solar-system
    // sectors are off).
    halfExtent: HOME_POCKET_HALF_EXTENT, margin: 250, step: sectorSpace(250), seed,
    ...(at ? { centreX: at.x, centreY: at.y } : {}),
    ...(clearing ? { within: clearing } : {}),
  });
  if (site === null) {
    h.logger.warn({ sectorKey, baseId: plan.baseId, tier: profile.tier, role: profile.role }, 'npc base: no site fits; base skipped');
    return null;
  }
  for (const i of site.overlapped) h.evictSwarmEntity(rocks[i]!, { broadcast: false, emitDestroyed: false });
  const r = sub.seed({ ...spec, x: site.x, y: site.y }, grown);
  // v4 M2 — a garrison flies a patrol round its approaches.
  if (profile.role === 'military') addGarrisonPatrol(h, `${sectorKey}-${plan.baseId}`, r.owner, profile.ownerFaction, profile.tier, site.x, site.y);
  h.logger.info({
    sectorKey, baseId: plan.baseId, tier: profile.tier, role: profile.role, owner: r.owner, x: Math.round(site.x), y: Math.round(site.y),
    placed: r.placed, rejectedPlace: r.rejectedPlace, rejectedEdge: r.rejectedEdge, asteroidsCleared: site.overlapped.length,
  }, 'galaxy npc base seeded');
  // Later bases keep this far from this one's footprint (room for its
  // bastions, its minefield and traffic between the two).
  const gap = NPC_BASE_GAP;
  return {
    x: site.x + (ext.x0 + ext.x1) / 2,
    y: site.y + (ext.y0 + ext.y1) / 2,
    hw: (ext.x1 - ext.x0) / 2 + gap,
    hh: (ext.y1 - ext.y0) / 2 + gap,
  };
}

/** v4 M2 — give a seeded garrison its patrol: corners from the base's
 *  footprint, 3 ships (4 for a stronghold or citadel). */
function addGarrisonPatrol(h: NpcBaseSeedHost, tag: string, owner: string, faction: FactionId, tier: string, cx: number, cy: number): void {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const rec of h.structureRegistry.all()) {
    if (rec.owner !== owner) continue;
    const hw = rec.halfW ?? rec.radius, hh = rec.halfH ?? rec.radius;
    x0 = Math.min(x0, rec.x - hw); x1 = Math.max(x1, rec.x + hw);
    y0 = Math.min(y0, rec.y - hh); y1 = Math.max(y1, rec.y + hh);
  }
  if (!Number.isFinite(x0)) return;
  const count = tier === 'stronghold' || tier === 'citadel' ? 4 : 3;
  // Capture 4E (S5) — the garrison stands down if its base falls.
  h.patrols.watchBaseFalls(h.structureRegistry);
  h.patrols.addBase(tag, owner, faction, { x0, x1, y0, y1 }, cx, cy, count);
}

/** D2 — seed NPC bases from the generator (built, stocked, recipes + bound
 *  blueprints loaded), then run one grid pulse so power settles. */
export function seedNpcBases(h: NpcBaseSeedHost, specs: readonly NpcBaseSpec[]): void {
  const sub = new NpcBaseSubsystem({
    registry: h.structureRegistry,
    place: (owner, kind, x, y, rot) => h.structurePlacement().place(owner, kind, x, y, { skipAutoConnect: true, rot }),
    setHealth: (id, hp) => h.swarmHealth().set(id, hp),
    getObstacles: (near) => h.obstacles.rocks(near),
  });
  const fallen = fallenBaseOrigins(h.structureRegistry); // 4E S6
  for (const spec of specs.slice(0, 8)) {
    if (fallen.has(npcOwner(sub.profileOf(spec).ownerFaction, spec.baseId))) continue;
    const r = sub.seed(spec);
    // v4 M2 — a garrison flies its patrol here too (showcase / test rooms).
    if (spec.role === 'military') {
      addGarrisonPatrol(h, `${h.sectorKey() ?? 'room'}-${spec.baseId}`, r.owner, spec.profile?.ownerFaction ?? spec.side ?? 'traders', spec.tier, spec.x, spec.y);
    }
    h.logger.info({ baseId: spec.baseId, role: spec.role, tier: spec.tier, owner: r.owner, placed: r.placed, rejectedPlace: r.rejectedPlace, rejectedEdge: r.rejectedEdge }, 'npc base seeded');
  }
  h.structureGridTick();
}

