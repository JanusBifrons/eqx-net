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
 *
 * Who works against whom on the meter is `controlOpposes` below. The
 * Ancients never count (`countsForControl`).
 */
import { defaultFactionPolicy, isNpcFactionId, npcFactionDef } from '../../shared-types/factions.js';
import { createRelationContext, npcOwner, relationOf } from '../../shared-types/relations.js';
import type { SidePresence } from '../../core/territory/sectorControl.js';
import { getTradeSink } from '../economy/tradeSink.js';

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

/** The same standing web + policies a room's relation context reads. */
const CONTROL_RELATIONS = createRelationContext({
  standing: { of: (from, to) => getTradeSink()?.standing?.(from, to) ?? 0 },
  policyOf: (faction) => getTradeSink()?.policyOf?.(faction) ?? defaultFactionPolicy(faction),
});

/**
 * True when side `a` pushes against side `b` on the control meter. Symmetric.
 *  - Two NPC factions: hostile by `relationOf` (the allegiance stance table,
 *    then standing + policy). So robots fight everyone; Sol, the Traders and
 *    the other powers do not push against each other.
 *  - A player and anyone else: always. The stance table leaves players neutral
 *    to everyone but robots, and player policies never turn hostile by
 *    standing, so the existing data cannot say who a player contests; the
 *    owner's "everything is capturable" rule needs players to contest every
 *    other side (other players included).
 */
export function controlOpposes(a: string, b: string): boolean {
  if (a === b) return false;
  if (!isNpcFactionId(a) || !isNpcFactionId(b)) return true;
  const oa = npcOwner(a);
  const ob = npcOwner(b);
  return relationOf(oa, ob, CONTROL_RELATIONS) === 'hostile' || relationOf(ob, oa, CONTROL_RELATIONS) === 'hostile';
}

/**
 * True when `faction` takes part in sector control. The Ancients (kind
 * `ancient`, the alien-gate owners) don't count for capture: the one choke
 * point is `fillSectorPresence`; a restored share of theirs is dropped too.
 */
export function countsForControl(faction: string): boolean {
  return npcFactionDef(faction)?.kind !== 'ancient';
}

/** The robots' side id on the meter (the `robots` NPC faction). */
export const ROBOT_SIDE = 'robots';

/**
 * Fill `out` with one sector's presence for `stepMultiControl`: every faction
 * from `byFaction`, with the robots taken from the robot director's count and
 * the nexus instead (a robot hull counts with the robot weight, never also as
 * a ship). `pool` recycles the presence records across calls.
 */
export function fillSectorPresence(
  out: Map<string, SidePresence>,
  pool: SidePresence[],
  byFaction: ReadonlyMap<string, FactionCounts> | undefined,
  robots: number,
  nexus: boolean,
): void {
  for (const p of out.values()) pool.push(p);
  out.clear();
  const take = (): SidePresence => {
    const p = pool.pop() ?? { ships: 0, structures: 0, robots: 0, nexus: false };
    p.ships = 0; p.structures = 0; p.robots = 0; p.nexus = false;
    return p;
  };
  if (byFaction) {
    for (const [faction, c] of byFaction) {
      if (!countsForControl(faction)) continue;
      const ships = faction === ROBOT_SIDE ? 0 : c.ships;
      if (ships === 0 && c.structures === 0) continue;
      const p = take();
      p.ships = ships;
      p.structures = c.structures;
      out.set(faction, p);
    }
  }
  if (robots > 0 || nexus) {
    let p = out.get(ROBOT_SIDE);
    if (!p) { p = take(); out.set(ROBOT_SIDE, p); }
    p.robots = robots;
    p.nexus = nexus;
  }
}
