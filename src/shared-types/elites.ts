/**
 * Named elites (Living World P4a, plan peppy-jumping-pinwheel).
 *
 * An elite is an ordinary NPC ship kind with a NAME, a much bigger hull and
 * guaranteed rare loot. Nothing about it is a new ship kind (no catalogue bump):
 * the swarm record carries the elite tag server-side, and clients learn of it
 * through the slim `drones[].elite` snapshot field (the name) and the galaxy
 * snapshot's per-sector `elite`. Shared so both sides agree (#15).
 */
import type { Hold } from './goods.js';
import type { ShipKindId } from './shipKinds.js';
import { rollLoot } from './lootTables.js';
import { ELITE_BLUEPRINT_CHANCE, rollBlueprint } from './blueprints.js';

/** Elite bot ids (owned by the server `EliteDirector`). */
export const ELITE_ID_PREFIX = 'elite-';

export function isEliteId(id: string): boolean {
  return id.startsWith(ELITE_ID_PREFIX);
}

/** An elite's hull is this many times its kind's. */
export const ELITE_HEALTH_MUL = 4;

/** The kinds an elite can be (heavier hulls read as a "boss"). */
export const ELITE_KINDS: readonly ShipKindId[] = ['gunship', 'missile-frigate', 'heavy', 'robot-hexagon'];

const TITLES = ['Dread', 'Iron', 'Crimson', 'Silent', 'Hollow', 'Grim', 'Ashen', 'Feral', 'Pale', 'Storm'];
const NAMES = ['Vexis', 'Morrow', 'Kharn', 'Sable', 'Oruk', 'Thessa', 'Drake', 'Nyx', 'Corvan', 'Halric', 'Zeph', 'Mauler'];

/** A deterministic display name for an elite (`rng` ∈ [0, 1)). */
export function eliteName(rng: () => number): string {
  const t = TITLES[Math.floor(rng() * TITLES.length)]!;
  const n = NAMES[Math.floor(rng() * NAMES.length)]!;
  return `${t} ${n}`;
}

/**
 * An elite's drop: its kind's table rolled three times, plus a guaranteed
 * 1–3 Robot Cores and 200–500 credits — the reason to hunt it.
 */
export function rollEliteLoot(kindId: string | null | undefined, rng: () => number): Hold {
  const out: Hold = { goods: {}, credits: 0, blueprints: [] };
  for (let i = 0; i < 3; i++) {
    const h = rollLoot(kindId, rng);
    out.credits += h.credits;
    for (const [g, n] of Object.entries(h.goods)) {
      const k = g as keyof Hold['goods'];
      out.goods[k] = (out.goods[k] ?? 0) + (n ?? 0);
    }
  }
  out.goods.core = (out.goods.core ?? 0) + 1 + Math.floor(rng() * 3);
  out.credits += 200 + Math.floor(rng() * 301);
  // P5 — elites are the main blueprint source.
  const bp = rollBlueprint(rng, ELITE_BLUEPRINT_CHANCE);
  if (bp !== null) out.blueprints.push(bp);
  return out;
}
