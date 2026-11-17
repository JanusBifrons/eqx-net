/**
 * Asteroid ore: the ONE path that takes ore out of a rock (asteroid-interaction
 * -model ADR), owned by `SectorRoom` and shared by every extractor.
 *
 * - `draw` decrements a rock's finite pool (the grid Miner's hook);
 * - `mine` draws into a hold, sized to its free weight first (robot
 *   harvesters);
 * - `cutYield`: the mining laser pays NO ore per hit (owner 2026-11-17: all
 *   mined ore arrives as ore pods). It cuts the rock, the rock's whole pool
 *   is shared out to its pieces by area, and each worn-out piece's pod
 *   carries its share (rockCut.ts, `dropPieceSalvage`).
 * - A cut-field rock (macro terrain v2) yields the field's ore at its centre
 *   (`oreAtCentre` → `oreRow`); other rocks use their
 *   `asteroidResource`.
 *
 * Docs: docs/features/mining-and-salvage.md ("Mining asteroids").
 */
import { cloneHold, emptyHold, holdWeight } from '../../core/cargo/hold.js';
import { GOOD_IDS, type GoodId } from '../../shared-types/goods.js';
import { ASTEROID_YIELD, asteroidYield, asteroidYieldWeightPerUnit, oreRow, yieldInto, type AsteroidResourceId, type YieldRow } from '../../shared-types/asteroidResources.js';
import { getHoldStore } from '../db/PersistenceWorker.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';

export interface OreDrawDeps {
  swarmRegistry: {
    get(id: string): SwarmEntityRecord | null;
    getByEntityId(entityId: number): SwarmEntityRecord | null;
  };
  sectorKey(): string | null;
  /** The field ore at `rock`'s centre, into `out`; false when `rock` is
   *  not a cut-field rock. */
  oreAtCentre?(rock: SwarmEntityRecord, out: { ice: number; crystal: number }): boolean;
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

  /** Rock cut: the ONE ore hook of a cut rock (rockCut.ts). A piece of rock
   *  `rockId` (its stable id; the rock itself is gone) became an ore pod
   *  centred at world (x, y) carrying `units` of its ore: the goods it holds,
   *  split by the rock's yield (`asteroidYield`, as every draw is). The
   *  rock's pool was shared out to its pieces by area when it broke, so this
   *  draws nothing more from the registry. The point is the hook's key for
   *  a later per-point ore tint (macro terrain). */
  cutYield(rockId: string, x: number, y: number, units: number, resource: AsteroidResourceId): Partial<Record<GoodId, number>> {
    void rockId; void x; void y;
    return units > 0 ? asteroidYield(resource, Math.floor(units)) : {};
  }
}
