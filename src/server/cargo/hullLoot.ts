/**
 * A ship's HULL loot: its kind's loot table (`rollLoot`, or an elite's
 * `rollEliteLoot`) rolled from a seed, so the same ship always rolls the same
 * thing. Every ship, whoever flies it (owner 2026-11-15, "why would the player
 * be special?"): an AI pilot's ship rolls it into its hold once per spawn
 * (`SectorRoom.npcHold`, seed `<id>:<entityId>`); a player's ship rolls it as
 * it dies (seed: its shipInstanceId) and drops it in the pod with its hold.
 * The `npc-hold` stream name is kept so existing seeded rolls hold.
 */
import type { Hold } from '../../shared-types/goods.js';
import { rollLoot, vaporiseSalvageBonus } from '../../shared-types/lootTables.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { rollEliteLoot } from '../../shared-types/elites.js';
import { stream } from '../../core/random/rng.js';
import { hashString } from '../../core/bases/baseProfile.js';
import { SCRAP_BURST_SPEED } from '../../core/swarm/scrapConstants.js';

export function rollHullLoot(seedKey: string, kindId: string | null | undefined, elite: boolean): Hold {
  const rng = stream(hashString(seedKey), 'npc-hold');
  const f = (): number => rng.u32() / 4294967296;
  return elite ? rollEliteLoot(kindId, f) : rollLoot(kindId, f);
}

/** Vaporised (owner 2026-11-15): the extra salvage an AI ship's pod gets on
 *  top of its hold, scaling only its hull roll's salvage still aboard
 *  (`min(rolled, aboard)`: a break-in's take or a harvester's scooped cargo
 *  never scales). Undefined when there is none. */
export function vaporisedSalvageExtra(seedKey: string, kindId: string | null | undefined, elite: boolean, aboard: number): Hold | undefined {
  const rolled = rollHullLoot(seedKey, kindId, elite).goods.salvage ?? 0;
  const bonus = vaporiseSalvageBonus(Math.min(rolled, aboard));
  return bonus > 0 ? { goods: { salvage: bonus }, blueprints: [] } : undefined;
}

/** A player-flown ship's hull loot as it dies (seed: its shipInstanceId; it
 *  has no spawn roll), its salvage × `VAPORISE_SALVAGE_MUL` when vaporised. */
export function deathHullLoot(shipInstanceId: string, kindId: string, vaporised: boolean): Hold {
  const hull = rollHullLoot(shipInstanceId, kindId, false);
  const s = hull.goods.salvage ?? 0;
  if (vaporised && s > 0) hull.goods.salvage = s + vaporiseSalvageBonus(s);
  return hull;
}

/** A kill pod spawns this many hull radii (plus its own radius) from the dead
 *  ship's centre: beside the wreck, not in it. */
export const KILL_POD_CLEAR_RADII = 1.2;

/** The gentle push (u/s) a death pod gets away from its wreck, on top of the
 *  ship's own velocity: under a scrap burst, so it eases clear of the
 *  break-up rather than flying off (owner 2026-11-17: the pod floats). */
export const DEATH_POD_PUSH = SCRAP_BURST_SPEED * 0.5;

/**
 * Where a dead ship's pod spawns (every ship, whoever flies it): just outside
 * the hull, not in it, so it never hides the break-up (owner's v5 film,
 * 2026-11-13). To the SIDE of the killer's line from (sx, sy), where the
 * wreck's pieces and a heavy beam's follow-through don't go; side and, with
 * no known killer (NaN), direction come from `seed`. Writes `out`: the spot
 * and (ux, uy), the unit push direction away from the wreck
 * (`DEATH_POD_PUSH`).
 */
export function killPodSpot(
  out: { x: number; y: number; ux: number; uy: number }, seed: number, cx: number, cy: number, hullRadius: number, sx: number, sy: number,
): { x: number; y: number; ux: number; uy: number } {
  const lx = cx - sx;
  const ly = cy - sy;
  const ll = Math.hypot(lx, ly);
  let ux: number;
  let uy: number;
  if (ll > 1e-6) {
    const side = (seed & 1) === 0 ? 1 : -1;
    ux = (-ly / ll) * side;
    uy = (lx / ll) * side;
  } else {
    const a = (seed / 4294967296) * 2 * Math.PI;
    ux = Math.cos(a);
    uy = Math.sin(a);
  }
  const off = hullRadius * KILL_POD_CLEAR_RADII + getShipKind('cargo-pod').radius;
  out.x = cx + ux * off;
  out.y = cy + uy * off;
  out.ux = ux;
  out.uy = uy;
  return out;
}
