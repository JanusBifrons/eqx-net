/**
 * Starter grant — the once-per-account gift a pilot gets on a fresh launch:
 * one packed Capital crate (`structure:capital`) plus two JUNK blueprint
 * copies (`makeBlueprint` junk tier, 2 runs each): the Mining Skiff and the
 * Interceptor, in the hold of the ship they launch (copies sit in
 * `hold.blueprints`, as a looted junk copy does, and weigh nothing). Anything
 * lost before use drops as loot with the rest of the hold and is never replaced.
 *
 * The "given" flag lives on the player's economy row (`starterGranted`, the
 * `freeLaunches` pattern: absent = not yet given, so existing accounts get it
 * once too). The flag and the hold write land in ONE atomic persistence group,
 * so a crash can never grant twice or mark it given without the items. Later
 * starter items join `grantStarter` here, under the same flag.
 */
import { addPacked, cloneHold, emptyHold, holdWeight, packedWeightOf } from '../../core/cargo/hold.js';
import { makeBlueprint } from '../../shared-types/blueprints.js';
import { cargoCapacityForMaxHealth } from '../../shared-types/goods.js';
import { blueprintProductFor, type RecipeId } from '../../shared-types/recipes.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import type { HoldRecord, HoldStore } from '../cargo/HoldStore.js';
import type { EconomyStore } from './EconomyStore.js';

/** The starter crate's product and quality. */
export const STARTER_CAPITAL_PRODUCT = 'structure:capital';
export const STARTER_CAPITAL_QUALITY = 50;

/** The starter junk blueprint copies: the recipes they unlock (owner 2026-11-20). */
export const STARTER_JUNK_RECIPES: readonly RecipeId[] = ['build_mining_skiff', 'build_interceptor'];

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
 * it is tried again on the next launch — crate and copies together, all or
 * nothing). `rng` rolls the copies' uids + output stat (default Math.random).
 */
export function grantStarter(
  deps: { econ: StarterGrantEconomy | null; holds: Pick<HoldStore, 'get' | 'commit'>; rng?: () => number },
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
  const rng = deps.rng ?? Math.random;
  for (const r of STARTER_JUNK_RECIPES) hold.blueprints.push(makeBlueprint(blueprintProductFor(r), 'bpc', rng, { junk: true }));
  const next: HoldRecord = rec
    ? { ...rec, hold }
    : { holderUid: shipInstanceId, holderType: 'ship', ownerId: playerId, sectorKey: null, x: null, y: null, hold, expiresAt: null };
  holds.commit([next], [], true, [econ.markStarterGranted(playerId)]);
  return true;
}
