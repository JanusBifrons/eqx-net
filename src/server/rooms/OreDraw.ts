/**
 * Asteroid ore: the ONE path that takes ore out of a rock (asteroid-interaction
 * -model ADR), owned by `SectorRoom` and shared by every extractor.
 *
 * - `draw` decrements a rock's finite pool (the grid Miner's hook);
 * - `mine` draws into a hold, sized to its free weight first (robot
 *   harvesters, and the mining laser's flush below);
 * - `onHit` / `flush`: a hit on a rock owes its shooter ore
 *   (`damage × weaponTargetFactor(def, 'rock') × ORE_UNITS_PER_DAMAGE`; the
 *   rock factor is 0 for every weapon but the mining laser), and the room's
 *   1 Hz grid pulse pays it out through `mine` (plan partitioned-chasing-lark
 *   PR 8, "batch ore draws to the 1 Hz pulse"): one hold commit per shooter
 *   per rock per pulse, never one per hit.
 *
 * Docs: docs/features/mining-and-salvage.md ("Mining asteroids").
 */
import { getWeapon, weaponTargetFactor, type WeaponId } from '../../core/combat/WeaponCatalogue.js';
import { cloneHold, emptyHold, holdWeight } from '../../core/cargo/hold.js';
import { GOOD_IDS, type GoodId } from '../../shared-types/goods.js';
import { ASTEROID_YIELD, asteroidYieldWeightPerUnit, yieldInto } from '../../shared-types/asteroidResources.js';
import { getHoldStore } from '../db/PersistenceWorker.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';

/** Ore units one point of rock-factored damage draws. The mining laser
 *  (120 × 6 Hz = 720/s) draws 30 units a second per beam: a robot
 *  harvester's mining step, 1.5× a grid Miner's 20 a pulse. */
export const ORE_UNITS_PER_DAMAGE = 1 / 24;

/** Where a shooter's ore goes: a pilot's ship hold (`ownerId` = the pilot) or
 *  an ownerless NPC hold (`ownerId` null, a 'hauler' row). */
export interface OreHolder { uid: string; ownerId: string | null; capacity: number }

export interface OreDrawDeps {
  swarmRegistry: {
    get(id: string): SwarmEntityRecord | null;
    getByEntityId(entityId: number): SwarmEntityRecord | null;
  };
  /** Fill `out` with `shooterId`'s hold; false = it has none here (the rock keeps its ore). */
  holderOf(shooterId: string, out: OreHolder): boolean;
  sectorKey(): string | null;
}

export class OreDraw {
  /** shooter → rock entityId → ore owed since the last pulse. Inner maps are
   *  reused across pulses; a shooter idle for a whole pulse is forgotten. */
  private readonly owed = new Map<string, Map<number, number>>();
  private readonly _holder: OreHolder = { uid: '', ownerId: null, capacity: 0 };
  /** Reused yield record (`yieldInto`). */
  private readonly yieldScratch: Partial<Record<GoodId, number>> = {};

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
    const row = ASTEROID_YIELD[rock.asteroidResource ?? 'rock'];
    const want = Math.min(maxUnits, Math.floor((capacity - before) / asteroidYieldWeightPerUnit(row)));
    if (want <= 0) return 0;
    const drawn = this.draw(entityId, want);
    if (drawn <= 0) return 0;
    const yieldOf = yieldInto(row, drawn, this.yieldScratch);
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

  /** A weapon hit landed on `targetId` (from `SectorRoom.applyDamage`). On a
   *  rock it owes the shooter ore; anything else costs one Map lookup.
   *  Allocates only on a shooter's first rock hit (#14). */
  onHit(targetId: string, shooterId: string, damage: number, weaponId: WeaponId): void {
    const rock = this.d.swarmRegistry.get(targetId);
    if (rock === null || rock.kind !== 0) return;
    const units = damage * weaponTargetFactor(getWeapon(weaponId), 'rock') * ORE_UNITS_PER_DAMAGE;
    if (!(units > 0)) return;
    let byRock = this.owed.get(shooterId);
    if (byRock === undefined) { byRock = new Map(); this.owed.set(shooterId, byRock); }
    byRock.set(rock.entityId, (byRock.get(rock.entityId) ?? 0) + units);
  }

  /** The 1 Hz pulse: pay out what each shooter is owed, whole units, through
   *  `mine`. A part unit left over is dropped (under a unit a second). */
  flush(): void {
    const h = this._holder;
    for (const [shooterId, byRock] of this.owed) {
      if (byRock.size === 0 || !this.d.holderOf(shooterId, h)) { this.owed.delete(shooterId); continue; }
      for (const [entityId, units] of byRock) {
        const whole = Math.floor(units);
        if (whole > 0) this.mine(h.uid, h.ownerId, entityId, whole, h.capacity);
        // Rock splitting hooks in here once macro terrain (#645) lands: a rock
        // the beam has worn down breaks up through the wreck split code
        // (plan partitioned-chasing-lark, "Asteroids"). Not yet: rocks only
        // lose ore.
      }
      byRock.clear();
    }
  }
}
