/**
 * Salvage bits of a weapon-group lock (salvage plan PR 16, wiring): which
 * locks are salvage (a wreck piece, a field rock or an ore pod: the bottom
 * rung, every tractor pulls it, no laser cuts it), each piece's size tier
 * (`salvageTier`, the size ladder: from its mass alone), and which it can
 * take in whole (`salvageConsumable`: the factory line). `LockSubsystem`
 * keeps them on each lock entry (refreshed every lock step), hands them to
 * the shared `pickTurretLock` (a laser cuts only pieces above its size's
 * tractor, a tractor pulls only pieces within its size's pull) and puts them
 * on the own-ship wire lock (`f`), so the client's predicted aim and fire
 * gate pick the same (#15, #16).
 *
 * Two halves: `lockSalvageFlags` (LockSubsystem side, pure over its deps)
 * and `LockSalvageLookup` (SectorRoom side: the room's registries behind
 * three narrow callbacks). Allocation-free (#14): module scratch.
 */
import { LOCK_CONSUMABLE, LOCK_SALVAGE, lockTierBits } from '../../core/combat/turretLockPick.js';
import { mountTier, salvageConsumable, salvageConsumeMass, salvageTier } from '../../core/combat/salvageTargeting.js';
import { SWARM_KIND_ASTEROID, SWARM_KIND_WRECK, isLootPod } from '../../shared-types/swarmWireFormat.js';
import type { ShipKind, WeaponMount } from '../../shared-types/shipKinds/types.js';
import type { PieceStoreView } from './wreckLineage.js';

/** What `salvageOf` fills for a salvage lock: the piece's `pieceStoreOf`
 *  view (mass: its size tier, a tractor accelerates it by F / mass, and the consume
 *  size test; holdWeight: what it stores as; each Infinity for a field rock,
 *  never towed, taken in or stored) and the ship's free hold. */
export interface LockSalvageView extends PieceStoreView {
  /** The locking ship's free hold weight. */
  freeHold: number;
  /** An ore (loot) pod: the ladder's last step (`lockSalvageFlags`). */
  pod?: boolean;
}

/** The salvage half of `LockSubsystemDeps`. */
export interface LockSalvageDeps {
  /** Fill `out` and return true when lock target `key` is salvage (a wreck
   *  piece or a field rock); false for anything else. Absent: no salvage
   *  bits (every lock is 0, the pick exactly as before). */
  salvageOf?(playerId: string, key: string, out: LockSalvageView): boolean;
}

const view: LockSalvageView = { mass: 0, radius: 0, qty: 0, ore: undefined, holdWeight: 0, freeHold: 0, pod: false };
/** An ore pod's bits: salvage on the bottom rung (AA), never consumable (it
 *  is taken in on touching the hull, or in a tractor's hold zone). */
const POD_FLAGS = LOCK_SALVAGE | lockTierBits(mountTier('AA'));
/** `LOCK_SALVAGE` | the piece's tier bits (`lockTierBits(salvageTier(mass))`,
 *  ship-independent; a field rock's Infinity mass is tier 0, none)
 *  (| `LOCK_CONSUMABLE`) for lock `key` of `playerId`'s ship (`ship`: its
 *  kind, whose mining tools judge consumption (hold size: the AA tier), as the loot
 *  pickup does), or 0 when it is not salvage. */
export function lockSalvageFlags(
  d: LockSalvageDeps, ship: { kind: ShipKind; activated: ReadonlyArray<WeaponMount> } | null, playerId: string, key: string,
): number {
  if (d.salvageOf === undefined || !d.salvageOf(playerId, key, view)) return 0;
  if (view.pod === true) return POD_FLAGS;
  const f = LOCK_SALVAGE | lockTierBits(salvageTier(view.mass));
  if (ship === null) return f;
  return salvageConsumable(view, salvageConsumeMass(ship.kind), view.freeHold) ? f | LOCK_CONSUMABLE : f;
}

/** The swarm entity id of an `s:<n>` lock key, or -1 (no string slicing, #14). */
export function swarmLockId(key: string): number {
  if (key.length < 3 || key.charCodeAt(0) !== 115 /* s */ || key.charCodeAt(1) !== 58 /* : */) return -1;
  let n = 0;
  for (let i = 2; i < key.length; i++) {
    const c = key.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return -1;
    n = n * 10 + c;
  }
  return n;
}

/** The room's side of `salvageOf`, over the registries it already has. */
export interface LockSalvageRoom<S> {
  /** The live swarm record of entity id `n` (kind, string id, drawn kind). */
  swarm(n: number): { kind: number; id: string; shipKind?: string | null } | null | undefined;
  /** A live wreck piece's store view (`CapitalWreckSubsystem.pieceStore`); false when `id` is not one. */
  piece(id: string, out: LockSalvageView): boolean;
  /** Free hold weight of ship `ship`. */
  freeHold(ship: S): number;
}

/** SectorRoom's `salvageOf`: a wreck piece (swarm kind 4) is salvage with its
 *  own mass and stored weight; a field rock (kind 0) is salvage the lasers
 *  mine in place, never towed; an ore pod (`isLootPod`) is `pod`. */
export class LockSalvageLookup<S> {
  constructor(private readonly r: LockSalvageRoom<S>) {}

  fill(ship: S | undefined, key: string, out: LockSalvageView): boolean {
    out.pod = false;
    if (ship === undefined) return false;
    const n = swarmLockId(key);
    const rec = n < 0 ? null : this.r.swarm(n);
    if (rec != null && isLootPod(rec)) { out.pod = true; out.freeHold = 0; return true; }
    if (rec === null || rec === undefined || (rec.kind !== SWARM_KIND_WRECK && rec.kind !== SWARM_KIND_ASTEROID)) return false;
    if (rec.kind === SWARM_KIND_ASTEROID || !this.r.piece(rec.id, out)) { out.mass = Infinity; out.radius = Infinity; out.holdWeight = Infinity; }
    out.freeHold = Math.max(0, this.r.freeHold(ship));
    return true;
  }
}
