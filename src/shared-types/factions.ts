/**
 * Factions (plan soft-leaping-truffle v4, F1). Everything is a faction:
 *
 *  - every player is a faction of one (their faction id IS their player id)
 *    until player factions can be founded and joined (a later plan);
 *  - the NPC factions below: the original sides (drones, robots, traders), the
 *    four region powers, and the Ancients who own the alien gates. Minor
 *    factions (generated mining companies, freight companies, militias) are
 *    registered at runtime by `registerNpcFactions` (F2).
 *
 * Every faction has a STANDING toward every other faction, −100..100, and the
 * two directions are separate: A's view of B is not B's view of A. Standing
 * starts at 0. What a faction does with a standing is its POLICY: below
 * `hostileBelow` its turrets and patrols treat you as hostile, above
 * `alliedAbove` you are allied, below `refuseTradeBelow` it won't trade, and
 * `priceSwing` is how far standing moves its prices.
 *
 * The original allegiance stances (robots attack everything on sight; drones
 * and robots fight) are a fixed layer underneath (`allegiances.ts`). Standing
 * and policy sit on top of them and never soften them.
 *
 * Pure data, shared by server and client (invariant #15).
 */
import { NPC_ALLEGIANCE_IDS, PLAYERS_SIDE, stanceOf, type NpcAllegianceId, type Stance } from './allegiances.js';
import {
  REP_MAX,
  REP_MIN,
  REP_PRICE_SWING,
  ROBOT_TRUCE_AT,
  TRADER_REFUSE_BELOW,
} from './economy.js';

/** A faction id. NPC ids come from the catalogue; a player's is their player id. */
export type FactionId = string;

export const STANDING_MIN = REP_MIN;
export const STANDING_MAX = REP_MAX;

/** Clamp a standing to −100..100 and to 0.1 steps (one decimal on the wire). */
export function clampStanding(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const c = Math.max(STANDING_MIN, Math.min(STANDING_MAX, v));
  return Math.round(c * 10) / 10;
}

export type FactionKind =
  /** One of the original AI sides (drones, robots). */
  | 'swarm'
  /** A galaxy-wide trading guild. */
  | 'guild'
  /** A region power. */
  | 'power'
  /** The Ancients (alien gates). */
  | 'ancient'
  /** A small generated faction (F2). */
  | 'minor'
  /** A player (a faction of one). */
  | 'player';

export interface FactionDef {
  readonly id: FactionId;
  readonly displayName: string;
  readonly kind: FactionKind;
  /** Radar / map tint. */
  readonly color: number;
  /** The allegiance stance layer this faction uses, if any. Factions without
   *  one are neutral to everyone, except that robots attack them on sight. */
  readonly allegiance?: NpcAllegianceId;
  /** Home sector (minor factions). */
  readonly home?: string;
}

/**
 * The fixed NPC factions. Append-only: ids are persisted in owner strings
 * (`npc:<factionId>:<baseId>`) and standings. The region powers reuse their
 * region ids from `galaxy.ts` (`core` is the Sol Dominion).
 */
export const FIXED_FACTIONS: readonly FactionDef[] = Object.freeze([
  { id: 'drones', displayName: 'Drones', kind: 'swarm', color: 0xff4444, allegiance: 'drones' },
  { id: 'robots', displayName: 'Robots', kind: 'swarm', color: 0xc070ff, allegiance: 'robots' },
  { id: 'traders', displayName: 'Traders', kind: 'guild', color: 0xffd060, allegiance: 'traders' },
  { id: 'core', displayName: 'Sol Dominion', kind: 'power', color: 0x6fb6ff },
  { id: 'verdant-reach', displayName: 'Verdant Reach', kind: 'power', color: 0x5fd6a0 },
  { id: 'crimson-expanse', displayName: 'Crimson Expanse', kind: 'power', color: 0xff7a5c },
  { id: 'azure-deep', displayName: 'Azure Deep', kind: 'power', color: 0x4fd0e8 },
  { id: 'ancients', displayName: 'The Ancients', kind: 'ancient', color: 0xd8c4ff },
] as FactionDef[]);

const NPC_FACTIONS = new Map<FactionId, FactionDef>(FIXED_FACTIONS.map((f) => [f.id, f]));

/** Register generated NPC factions (F2's minor factions). Fixed ids win; a
 *  repeat registration of the same id is ignored, so it is idempotent. */
export function registerNpcFactions(defs: readonly FactionDef[]): void {
  for (const d of defs) if (!NPC_FACTIONS.has(d.id)) NPC_FACTIONS.set(d.id, d);
}

/** Every NPC faction known to this process. */
export function npcFactions(): IterableIterator<FactionDef> {
  return NPC_FACTIONS.values();
}

export function isNpcFactionId(id: string): boolean {
  return NPC_FACTIONS.has(id);
}

export function npcFactionDef(id: FactionId): FactionDef | undefined {
  return NPC_FACTIONS.get(id);
}

/** A faction's display name ("Sol Dominion"); a player faction has none here
 *  (the caller shows the player's name). */
export function factionDisplayName(id: FactionId): string | undefined {
  return NPC_FACTIONS.get(id)?.displayName;
}

/** The allegiance stance side of a faction: an NPC faction's allegiance, the
 *  players side for a player, or null for an NPC faction without one. */
function sideOf(id: FactionId): NpcAllegianceId | typeof PLAYERS_SIDE | null {
  const def = NPC_FACTIONS.get(id);
  if (!def) return PLAYERS_SIDE;
  return def.allegiance ?? null;
}

/**
 * What faction `a` does to faction `b` UNPROVOKED (the fixed stance layer).
 * Same faction → friendly. Two factions with allegiances → the allegiance
 * table. Otherwise robots attack on sight and everyone else is neutral.
 */
export function factionStance(a: FactionId, b: FactionId): Stance {
  if (a === b) return 'friendly';
  const sa = sideOf(a);
  const sb = sideOf(b);
  if (sa !== null && sb !== null) return stanceOf(sa, sb);
  return sa === 'robots' ? 'hostile' : 'neutral';
}

// ── Policy ──────────────────────────────────────────────────────────────────

/**
 * How a faction treats others by standing (its view of them). Infinite
 * thresholds mean "never by standing alone". F3 lets a player edit their own.
 */
export interface FactionPolicy {
  /** Its turrets and patrols treat anyone it views below this as hostile. */
  readonly hostileBelow: number;
  /** Anyone it views above this is allied (gates, cargo, teleporters admit allies). */
  readonly alliedAbove: number;
  /** It refuses new trade with anyone it views below this. */
  readonly refuseTradeBelow: number;
  /** How far standing moves its prices: ±swing at ±100. */
  readonly priceSwing: number;
}

export const DEFAULT_FACTION_POLICY: FactionPolicy = Object.freeze({
  hostileBelow: -Infinity,
  alliedAbove: Infinity,
  refuseTradeBelow: -Infinity,
  priceSwing: 0,
});

/** Defaults that reproduce the pre-faction rules exactly: the trader price
 *  swing and refusal, and the robot truce (robots stay hostile below it). */
const POLICY_DEFAULTS: Readonly<Record<string, FactionPolicy>> = Object.freeze({
  traders: { ...DEFAULT_FACTION_POLICY, refuseTradeBelow: TRADER_REFUSE_BELOW, priceSwing: REP_PRICE_SWING },
  robots: { ...DEFAULT_FACTION_POLICY, hostileBelow: ROBOT_TRUCE_AT },
});

/** The default policy of a faction (players and most NPCs: never by standing). */
export function defaultFactionPolicy(id: FactionId): FactionPolicy {
  return POLICY_DEFAULTS[id] ?? DEFAULT_FACTION_POLICY;
}

/** True when the policy can change a relation (a cheap gate for hot paths). */
export function policyActsOnStanding(p: FactionPolicy): boolean {
  return p.hostileBelow !== -Infinity || p.alliedAbove !== Infinity;
}

/** A standing's plain-English label, the same scale everywhere. */
export function standingLabel(v: number): string {
  if (v >= 50) return 'Allied';
  if (v >= 15) return 'Friendly';
  if (v > -15) return 'Neutral';
  if (v > -50) return 'Wary';
  return 'Hostile';
}

/** True for the three original NPC sides (they keep their AI stance tables). */
export function isAllegianceFaction(id: FactionId): id is NpcAllegianceId {
  return (NPC_ALLEGIANCE_IDS as readonly string[]).includes(id);
}
