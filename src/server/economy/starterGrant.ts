/**
 * Starter grant — the once-per-account gift a pilot gets on a fresh launch:
 * one packed Capital crate (`structure:capital`) in the hold of the ship they
 * launch. A crate lost before it is placed drops as loot with the rest of the
 * hold and is never replaced.
 *
 * The "given" flag lives on the player's economy row (`starterGranted`, the
 * `freeLaunches` pattern: absent = not yet given, so existing accounts get it
 * once too). The flag and the hold write land in ONE atomic persistence group,
 * so a crash can never grant twice or mark it given without the crate. Later
 * starter items join `grantStarter` here, under the same flag.
 */
import { addPacked, cloneHold, emptyHold, holdWeight, packedWeightOf } from '../../core/cargo/hold.js';
import { cargoCapacityForMaxHealth } from '../../shared-types/goods.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import type { HoldRecord, HoldStore } from '../cargo/HoldStore.js';
import type { EconomyStore } from './EconomyStore.js';

/** The starter crate's product and quality. */
export const STARTER_CAPITAL_PRODUCT = 'structure:capital';
export const STARTER_CAPITAL_QUALITY = 50;

export type StarterGrantEconomy = Pick<EconomyStore, 'starterGranted' | 'markStarterGranted'>;

/** Boot wiring (economyBoot): null when the economy is not running ⇒ no grant. */
let _econ: StarterGrantEconomy | null = null;

export function setStarterGrantEconomy(econ: StarterGrantEconomy | null): void {
  _econ = econ;
}

export function getStarterGrantEconomy(): StarterGrantEconomy | null {
  return _econ;
}

/**
 * Give `playerId` their starter items in the hold of `shipInstanceId` (a hull
 * of `kind`), once per account. False (nothing changes) when already given,
 * when there is no economy, or when the hold has no room (never over capacity;
 * it is tried again on the next launch).
 */
export function grantStarter(
  deps: { econ: StarterGrantEconomy | null; holds: Pick<HoldStore, 'get' | 'commit'> },
  playerId: string,
  shipInstanceId: string,
  kind: string,
): boolean {
  const { econ, holds } = deps;
  if (econ === null || econ.starterGranted(playerId)) return false;
  const rec = holds.get(shipInstanceId);
  const hold = rec ? cloneHold(rec.hold) : emptyHold();
  const capacity = cargoCapacityForMaxHealth(getShipKind(kind as Parameters<typeof getShipKind>[0]));
  if (holdWeight(hold) + packedWeightOf(STARTER_CAPITAL_PRODUCT) > capacity) return false;
  addPacked(hold, STARTER_CAPITAL_PRODUCT, STARTER_CAPITAL_QUALITY);
  const next: HoldRecord = rec
    ? { ...rec, hold }
    : { holderUid: shipInstanceId, holderType: 'ship', ownerId: playerId, sectorKey: null, x: null, y: null, hold, expiresAt: null };
  holds.commit([next], [], true, [econ.markStarterGranted(playerId)]);
  return true;
}
