/**
 * Several NPC bases per galaxy sector (plan soft-leaping-truffle v3, phase T:
 * "several bases per sector inside the sector budget"). Pure.
 *
 * Base 0 is exactly the sector's original base (seed = hash of the sector key,
 * id `b0`), so adding this changed no existing base. Up to two more may join
 * it, each with its own seed and a DIFFERENT role from the bases already there
 * (a mining outpost beside a trade hub trades; two mining outposts mostly
 * don't). Every base is its own owner (`npc:<faction>:<baseId>`), so each has its
 * own grid and they trade by convoy like bases in different sectors.
 *
 * A stronghold or citadel takes most of a sector, so it holds its sector
 * alone, and the extra bases are outposts or settlements (they fit beside
 * each other). The NPC total stays within `NPC_STRUCTURES_PER_SECTOR_MAX`, counted by each
 * tier's structure ceiling, so a sector never exceeds the measured budget.
 */
import { NPC_STRUCTURES_PER_SECTOR_MAX } from '../../shared-types/structureBudgets.js';
import { TIER_LEVEL_CAP, TIER_WEALTH, baseProfileFor, contextForSector, hashString, seededRandom, type BaseProfile } from './baseProfile.js';
import { TRANSIT_HUB_BASE_ID, buildTransitNetwork, routeHops, type TransitNetwork } from './transitNetwork.js';
import { TIER_MAX_STRUCTURES } from './growBase.js';
import { sectorController } from '../galaxy/control.js';
import { getSector } from '../galaxy/galaxy.js';
import { minorFactionsOf, type FactionId, type MinorSpecialty } from '../../shared-types/factions.js';
import type { BaseRole } from './baseProfile.js';

/** Tiers too big to share a sector. */
const BIG: ReadonlySet<string> = new Set(['stronghold', 'citadel']);

export interface GalaxyBasePlan {
  baseId: string;
  seed: number;
  profile: BaseProfile;
}

/** The minor specialty that fits a base role best. */
const ROLE_SPECIALTY: Readonly<Record<BaseRole, MinorSpecialty>> = {
  mining: 'mining',
  refinery: 'manufacturer',
  workshop: 'manufacturer',
  manufactory: 'manufacturer',
  assembly: 'manufacturer',
  trade: 'freight',
  colony: 'freight',
  transit: 'freight',
};

/**
 * The owner faction of one planned base. `taken` holds owners already used in
 * this sector; they are much less likely to be picked again.
 */
export function chooseBaseOwner(sectorKey: string, role: BaseRole, rnd: () => number, taken: readonly FactionId[]): FactionId {
  const controller = sectorController(sectorKey);
  if (controller !== null) return role === 'trade' || role === 'transit' ? 'traders' : controller;
  const region = getSector(sectorKey)?.region ?? null;
  const weights: Array<[FactionId, number]> = [];
  if (region !== null) {
    for (const m of minorFactionsOf(region)) weights.push([m.id, m.specialty === ROLE_SPECIALTY[role] ? 4 : 1]);
    weights.push([region, 1.5]);
  }
  weights.push(['traders', role === 'trade' || role === 'transit' ? 4 : 0.5]);
  let total = 0;
  for (const w of weights) {
    if (taken.includes(w[0])) w[1] *= 0.15;
    total += w[1];
  }
  let t = rnd() * total;
  for (const [id, w] of weights) {
    t -= w;
    if (t < 0) return id;
  }
  return weights[weights.length - 1]![0];
}

/**
 * The NPC bases a galaxy sector holds, base 0 first, then (v4 H) its transit
 * hub if it has one; each base lists the transit links it ends. Deterministic.
 */
export function galaxyBasePlan(sectorKey: string): GalaxyBasePlan[] {
  const out = sectorBasePlan(sectorKey).map((b) => ({ ...b, profile: { ...b.profile } }));
  const net = transitNetwork();
  if (net.hubs.get(getSector(sectorKey)?.region ?? '') === sectorKey) {
    // Make room under the per-sector budget: drop extra bases, newest first.
    const hubTier = 'settlement' as const;
    let used = out.reduce((n, b) => n + TIER_MAX_STRUCTURES[b.profile.tier], 0);
    while (used + TIER_MAX_STRUCTURES[hubTier] > NPC_STRUCTURES_PER_SECTOR_MAX && out.length > 1) {
      used -= TIER_MAX_STRUCTURES[out.pop()!.profile.tier];
    }
    const seed = hashString(`${sectorKey}#${TRANSIT_HUB_BASE_ID}`);
    const [w0, w1] = TIER_WEALTH[hubTier];
    out.push({
      baseId: TRANSIT_HUB_BASE_ID,
      seed,
      profile: {
        tier: hubTier,
        role: 'transit',
        ownerFaction: chooseBaseOwner(sectorKey, 'transit', seededRandom(seed), []),
        wealth: Math.round((w0 + w1) / 2),
        levelCap: TIER_LEVEL_CAP[hubTier][0],
        // Open: anyone may fly onto its pads.
        fenced: false,
      },
    });
  }
  for (const b of out) {
    const mine = net.links.filter((l) => (l.a.sector === sectorKey && l.a.baseId === b.baseId) || (l.b.sector === sectorKey && l.b.baseId === b.baseId));
    if (mine.length > 0) b.profile = { ...b.profile, links: mine.map((l) => l.id) };
  }
  return out;
}

/** v4 H2 — route length between two sectors riding the transit links
 *  (memoised per pair; the network never changes at run time). */
const ROUTES = new Map<string, number>();
export function transitRouteHops(from: string, to: string): number {
  const key = from < to ? `${from}|${to}` : `${to}|${from}`;
  let h = ROUTES.get(key);
  if (h === undefined) {
    h = routeHops(from, to, transitNetwork());
    ROUTES.set(key, h);
  }
  return h;
}

let NETWORK: TransitNetwork | null = null;
/** The galaxy's transit network (built once, from the plans without links). */
export function transitNetwork(): TransitNetwork {
  NETWORK ??= buildTransitNetwork(sectorBasePlan);
  return NETWORK;
}

/** A sector's bases before the transit pass (v4 H): base 0, its extras and
 *  their owners. */
function sectorBasePlan(sectorKey: string): GalaxyBasePlan[] {
  const ctx = contextForSector(sectorKey);
  const seed0 = hashString(sectorKey);
  const out: GalaxyBasePlan[] = [{ baseId: 'b0', seed: seed0, profile: baseProfileFor(ctx, seed0) }];
  if (!BIG.has(out[0]!.profile.tier)) addExtraBases(sectorKey, ctx, seed0, out);
  // Owners (F2), from their own stream so the layout is unchanged.
  const ownerRnd = seededRandom(seed0 ^ 0x0f2a7c11);
  const taken: FactionId[] = [];
  for (const b of out) {
    const owner = chooseBaseOwner(sectorKey, b.profile.role, ownerRnd, taken);
    taken.push(owner);
    b.profile = { ...b.profile, ownerFaction: owner };
  }
  return out;
}

/** Up to two more outposts or settlements beside base 0 (in place). */
function addExtraBases(sectorKey: string, ctx: ReturnType<typeof contextForSector>, seed0: number, out: GalaxyBasePlan[]): void {
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
}
