/**
 * Freight contracting (plan soft-leaping-truffle v4, phase C). Who carries a
 * convoy, and for what cut. Pure and deterministic.
 *
 * A faction that runs its own freight carries its own goods: a region power,
 * the Traders guild, or a freight company. Anyone else (a mining company, a
 * manufacturer, a militia, a player) contracts the cheapest freight carrier
 * working in the region: its freight companies or the Traders. The carrier's
 * cut is a fixed share of the cargo's value, the same for every job it takes.
 *
 * A convoy's hauler flies for BOTH its owner and its carrier: raiding it
 * costs standing with each.
 */
import { minorFactionsOf, npcFactionDef, type FactionId } from '../../shared-types/factions.js';

/** The Traders guild takes this cut when contracted. */
export const TRADERS_CUT = 0.1;
/** A freight company's cut lies in this range (fixed per company). */
export const FREIGHT_CUT_MIN = 0.05;
export const FREIGHT_CUT_MAX = 0.15;

export interface CarrierChoice {
  carrier: FactionId;
  /** Share of the cargo's value the carrier is paid (0 when the owner carries). */
  cut: number;
}

/** True for a faction that hauls its own goods. */
export function runsOwnFreight(faction: FactionId): boolean {
  const def = npcFactionDef(faction);
  if (def === undefined) return false; // a player
  return def.kind === 'power' || def.kind === 'guild' || def.specialty === 'freight';
}

/** A carrier's cut (its fixed price): the Traders' is `TRADERS_CUT`, a
 *  freight company's is set by its id. */
export function carrierCut(faction: FactionId): number {
  if (faction === 'traders') return TRADERS_CUT;
  let h = 0x811c9dc5;
  for (let i = 0; i < faction.length; i++) {
    h ^= faction.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const t = (h % 1000) / 1000;
  return Math.round((FREIGHT_CUT_MIN + t * (FREIGHT_CUT_MAX - FREIGHT_CUT_MIN)) * 1000) / 1000;
}

/** Who carries `owner`'s convoy out of `region`, and for what cut. */
export function chooseCarrier(owner: FactionId, region: string | null): CarrierChoice {
  if (runsOwnFreight(owner)) return { carrier: owner, cut: 0 };
  let best: CarrierChoice = { carrier: 'traders', cut: TRADERS_CUT };
  if (region !== null) {
    for (const m of minorFactionsOf(region)) {
      if (m.specialty !== 'freight') continue;
      const cut = carrierCut(m.id);
      if (cut < best.cut || (cut === best.cut && m.id < best.carrier)) best = { carrier: m.id, cut };
    }
  }
  return best;
}
