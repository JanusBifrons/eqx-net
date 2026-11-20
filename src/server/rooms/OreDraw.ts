/**
 * Asteroid ore: the ONE path that takes ore out of a rock (asteroid-interaction
 * -model ADR), owned by `SectorRoom` and shared by every extractor.
 *
 * - `draw` decrements a rock's finite pool (the grid Miner's hook);
 * - `mine` draws into a hold, sized to its free weight first (robot
 *   harvesters);
 * - `chunkYield`: the mining laser pays NO ore per hit. It cuts the rock
 *   into pieces (rockCut.ts); a piece tractored to a hull goes into the hold
 *   whole as a rock CHUNK (owner 2026-11-17: never a pod, never ore on
 *   pickup), and this is the hidden ore it carries, which only a refinery
 *   turns into goods: its share by weight of the whole rock's fixed ore
 *   (owner 2026-11-20), so cutting smaller never loses ore.
 * - A cut-field rock (macro terrain v2) yields the field's ore at its centre
 *   (`oreAtCentre` → `oreRow`), and so do the chunks cut from it (their
 *   `WreckOre` rest frame, `oreAtRest`); other rocks use their
 *   `asteroidResource`.
 *
 * Docs: docs/features/mining-and-salvage.md ("Mining asteroids").
 */
import { cloneHold, emptyHold, holdWeight } from '../../core/cargo/hold.js';
import { GOOD_IDS, type GoodId } from '../../shared-types/goods.js';
import { ASTEROID_YIELD, asteroidYield, asteroidYieldWeightPerUnit, oreRow, yieldInto, type AsteroidResourceId, type YieldRow } from '../../shared-types/asteroidResources.js';
import { getHoldStore } from '../db/PersistenceWorker.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';

/** A whole rock's ore units per (rock mass)², and the least any rock holds
 *  (`rockOreTotal`). Fitted to what a full cut paid under the old 6 % floor
 *  (0.08 × chunk weight² per chunk): r40 140k, r80 484k, r160 9.3M, r260
 *  48.6M (rockFloor.test.ts). Big rocks stay steep, as the owner asked
 *  2026-11-17 ("very steep"). */
export const ROCK_ORE_PER_MASS_SQ = 0.055;
export const ROCK_ORE_MIN = 125_000;

/** A whole rock's fixed ore (owner 2026-11-20 "Ore shared by weight"): the
 *  same however finely it is cut. */
export function rockOreTotal(rockMass: number): number {
  return Math.max(ROCK_ORE_MIN, ROCK_ORE_PER_MASS_SQ * rockMass * rockMass);
}

/** A chunk's share of its rock's ore: total × (chunk mass / whole rock
 *  mass), rounded down. 0 for no mass. */
export function chunkOreUnits(mass: number, rockMass: number): number {
  if (!(mass > 0) || !(rockMass > 0)) return 0;
  return Math.floor(rockOreTotal(rockMass) * Math.min(1, mass / rockMass));
}

export interface OreDrawDeps {
  swarmRegistry: {
    get(id: string): SwarmEntityRecord | null;
    getByEntityId(entityId: number): SwarmEntityRecord | null;
  };
  sectorKey(): string | null;
  /** The field ore at `rock`'s centre, into `out`; false when `rock` is
   *  not a cut-field rock. */
  oreAtCentre?(rock: SwarmEntityRecord, out: { ice: number; crystal: number }): boolean;
  /** The field ore at world (x, y) on something cut from a field rock whose
   *  rest centre (restX, restY) now sits at (poseX, poseY) turned by
   *  `angle`, into `out` (`CutFieldSubsystem.oreAtRest`); false (out untouched)
   *  when the room has no field. */
  oreAtRest?(restX: number, restY: number, poseX: number, poseY: number, angle: number, x: number, y: number, out: { ice: number; crystal: number }): boolean;
}

export class OreDraw {
  /** Reused yield record (`yieldInto`). */
  private readonly yieldScratch: Partial<Record<GoodId, number>> = {};
  /** Reused field-ore sample and row. */
  private readonly conc = { ice: 0, crystal: 0 };
  private readonly rowScratch: Partial<Record<GoodId, number>> = {};

  constructor(private readonly d: OreDrawDeps) {}

  /** Draw up to `amount` from a rock's pool; returns what was ACTUALLY drawn
   *  (0 once exhausted). `resources === undefined` (un-seeded) ⇒ infinite. */
  draw(entityId: number, amount: number): number {
    const rec = this.d.swarmRegistry.getByEntityId(entityId);
    if (!rec || rec.resources === undefined) return amount;
    const drawn = Math.min(amount, rec.resources);
    rec.resources -= drawn;
    return drawn;
  }

  /** A rock's yield row (robot harvesters, the grid Miner): a cut-field
   *  rock's ore at its centre, else its `asteroidResource`. A field row is
   *  reused scratch: read it at once. */
  rowOf(rock: SwarmEntityRecord): YieldRow {
    const c = this.conc;
    return this.d.oreAtCentre?.(rock, c) === true
      ? oreRow(c, this.rowScratch)
      : ASTEROID_YIELD[rock.asteroidResource ?? 'rock'];
  }

  /** Mine up to `maxUnits` from rock `entityId` into `holderUid`'s hold, split by
   *  the rock's yield (`yieldInto`, the one split). The draw is sized to the hold's free
   *  weight first, so no ore is burned into a full hold. One hold commit; a
   *  pilot's hold is a 'ship' row (like a loot pickup), else an ownerless
   *  'hauler' row. Returns the weight gained. */
  mine(holderUid: string, ownerId: string | null, entityId: number, maxUnits: number, capacity: number): number {
    const rock = this.d.swarmRegistry.getByEntityId(entityId);
    if (!rock || rock.kind !== 0) return 0;
    const store = getHoldStore();
    const cur = store.get(holderUid);
    const hold = cur ? cloneHold(cur.hold) : emptyHold();
    const before = holdWeight(hold);
    const y = this.rowOf(rock);
    const want = Math.min(maxUnits, Math.floor((capacity - before) / asteroidYieldWeightPerUnit(y)));
    if (want <= 0) return 0;
    const drawn = this.draw(entityId, want);
    if (drawn <= 0) return 0;
    const yieldOf = yieldInto(y, drawn, this.yieldScratch);
    for (const g of GOOD_IDS) {
      const n = yieldOf[g] ?? 0;
      if (n > 0) hold.goods[g] = (hold.goods[g] ?? 0) + n;
    }
    const sectorKey = this.d.sectorKey();
    store.commit(
      [ownerId === null
        ? { holderUid, holderType: 'hauler', ownerId: null, sectorKey, x: null, y: null, hold, expiresAt: null }
        : { holderUid, holderType: 'ship', ownerId, sectorKey: null, x: null, y: null, hold, expiresAt: null }],
      [],
      sectorKey !== null,
    );
    return holdWeight(hold) - before;
  }

  /** Rock cut: the ONE ore hook of a cut rock. A piece of rock `rockId`
   *  (its stable id; the rock itself is gone) went into a hold at world
   *  (x, y) as a chunk of `mass`, cut from a whole rock of `rockMass`: the
   *  ore it holds, hidden until a refinery breaks it down. Its share by
   *  weight of the rock's fixed ore (`chunkOreUnits`; owner 2026-11-20 "Ore
   *  shared by weight": cutting smaller never loses ore), split by the
   *  rock's yield (`asteroidYield`, as every draw is). This draws nothing
   *  from the registry. A chunk of a cut-FIELD rock (`rest`: its
   *  `WreckOre` rest frame) is split by the field's ore instead, sampled
   *  through `oreAtRest` at the rock's rest centre, the same point a
   *  harvester draws the whole rock at (`rowOf`), so every chunk of one
   *  rock carries its mix. (x, y) stays the hook's key for a later
   *  per-piece vein. Allocates (one intake, never per tick). */
  chunkYield(
    rockId: string, x: number, y: number, mass: number, rockMass: number, resource: AsteroidResourceId,
    rest?: { readonly restX?: number | undefined; readonly restY?: number | undefined },
  ): Partial<Record<GoodId, number>> {
    void rockId; void x; void y;
    const units = chunkOreUnits(mass, rockMass);
    if (!(units > 0)) return {};
    const rx = rest?.restX, ry = rest?.restY;
    const c = this.conc;
    if (rx !== undefined && ry !== undefined && this.d.oreAtRest?.(rx, ry, rx, ry, 0, rx, ry, c) === true) {
      return asteroidYield(oreRow(c, this.rowScratch), units);
    }
    return asteroidYield(resource, units);
  }
}
