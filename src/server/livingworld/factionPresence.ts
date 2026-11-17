/**
 * Per-side presence in one sector, for the control meter for every side
 * (`core/territory/sectorControl` `stepMultiControl`). Filled by
 * `SectorRoom.liveCounts()` on the director's ~1.5 s control tick, never the
 * 60 Hz loop.
 *
 * Who a thing counts for:
 *  - a player hull → its pilot (every player is their own faction);
 *  - an NPC hull → its patrol faction, else its kind's allegiance;
 *  - a structure → its owner's faction (`parseOwner(owner).faction`).
 */
export interface FactionCounts {
  ships: number;
  structures: number;
}

export type FactionPresenceMap = Map<string, FactionCounts>;

/** Add one ship or structure to `faction`'s tally. Ignores an empty id. */
export function tallyFaction(m: FactionPresenceMap, faction: string | undefined, what: keyof FactionCounts): void {
  if (!faction) return;
  let c = m.get(faction);
  if (!c) { c = { ships: 0, structures: 0 }; m.set(faction, c); }
  c[what]++;
}
