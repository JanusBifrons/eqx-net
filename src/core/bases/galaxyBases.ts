/**
 * Several NPC bases per galaxy sector (plan soft-leaping-truffle v3, phase T:
 * "several bases per sector inside the sector budget"). Pure.
 *
 * Base 0 is exactly the sector's original base (seed = hash of the sector key,
 * id `b0`), so adding this changed no existing base. Up to two more may join
 * it, each with its own seed and a DIFFERENT role from the bases already there
 * (a mining outpost beside a trade hub trades; two mining outposts mostly
 * don't). Every base is its own owner (`npc:<side>:<baseId>`), so each has its
 * own grid and they trade by convoy like bases in different sectors.
 *
 * A stronghold or citadel takes most of a sector, so it holds its sector
 * alone, and the extra bases are outposts or settlements (they fit beside
 * each other). The NPC total stays within `NPC_STRUCTURES_PER_SECTOR_MAX`, counted by each
 * tier's structure ceiling, so a sector never exceeds the measured budget.
 */
import { NPC_STRUCTURES_PER_SECTOR_MAX } from '../../shared-types/structureBudgets.js';
import { baseProfileFor, contextForSector, hashString, seededRandom, type BaseProfile } from './baseProfile.js';
import { TIER_MAX_STRUCTURES } from './growBase.js';

/** Tiers too big to share a sector. */
const BIG: ReadonlySet<string> = new Set(['stronghold', 'citadel']);

export interface GalaxyBasePlan {
  baseId: string;
  seed: number;
  profile: BaseProfile;
}

/** The NPC bases a galaxy sector holds, base 0 first. Deterministic. */
export function galaxyBasePlan(sectorKey: string): GalaxyBasePlan[] {
  const ctx = contextForSector(sectorKey);
  const seed0 = hashString(sectorKey);
  const out: GalaxyBasePlan[] = [{ baseId: 'b0', seed: seed0, profile: baseProfileFor(ctx, seed0) }];
  if (BIG.has(out[0]!.profile.tier)) return out;
  let used = TIER_MAX_STRUCTURES[out[0]!.profile.tier];
  const rnd = seededRandom(seed0 ^ 0x2c1b3c6d);
  // About half the sectors get a second base, about a fifth a third.
  const extra = (rnd() < 0.5 ? 1 : 0) + (rnd() < 0.2 ? 1 : 0);
  for (let i = 1, tries = 0; out.length <= extra && tries < 6; tries++, i++) {
    const seed = hashString(`${sectorKey}#b${i}`);
    const profile = baseProfileFor(ctx, seed);
    if (BIG.has(profile.tier) || out.some((b) => b.profile.role === profile.role)) continue;
    const cost = TIER_MAX_STRUCTURES[profile.tier];
    if (used + cost > NPC_STRUCTURES_PER_SECTOR_MAX) continue;
    used += cost;
    out.push({ baseId: `b${i}`, seed, profile });
  }
  return out;
}
