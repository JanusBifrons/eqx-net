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
import { z } from 'zod';
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
  /** The region a power rules, or a minor faction works in. */
  readonly region?: string;
  /** What a minor faction does (it owns bases of matching roles). */
  readonly specialty?: MinorSpecialty;
  /** The shape of its ships' painted-section edges (livery look R&D). */
  readonly liveryEdge?: LiveryEdge;
}

/** Painted-section edge shapes a faction's livery can wear: a swept chevron
 *  (the sides reach further), a tongue (the centreline reaches further) or a
 *  dog-tooth. */
export type LiveryEdge = 'swept' | 'tongue' | 'tooth';
export const LIVERY_EDGES: readonly LiveryEdge[] = Object.freeze(['swept', 'tongue', 'tooth'] as const);

export type MinorSpecialty = 'mining' | 'freight' | 'manufacturer' | 'militia';

/**
 * The fixed NPC factions. Append-only: ids are persisted in owner strings
 * (`npc:<factionId>:<baseId>`) and standings. The region powers reuse their
 * region ids from `galaxy.ts` (`core` is the Sol Dominion).
 */
export const FIXED_FACTIONS: readonly FactionDef[] = Object.freeze([
  { id: 'drones', displayName: 'Drones', kind: 'swarm', color: 0xff4444, allegiance: 'drones', liveryEdge: 'swept' },
  { id: 'robots', displayName: 'Robots', kind: 'swarm', color: 0xc070ff, allegiance: 'robots', liveryEdge: 'tooth' },
  { id: 'traders', displayName: 'Traders', kind: 'guild', color: 0xffd060, allegiance: 'traders', liveryEdge: 'tongue' },
  { id: 'core', displayName: 'Sol Dominion', kind: 'power', color: 0x6fb6ff, region: 'core', liveryEdge: 'swept' },
  { id: 'verdant-reach', displayName: 'Verdant Reach', kind: 'power', color: 0x5fd6a0, region: 'verdant-reach', liveryEdge: 'tooth' },
  { id: 'crimson-expanse', displayName: 'Crimson Expanse', kind: 'power', color: 0xff7a5c, region: 'crimson-expanse', liveryEdge: 'tongue' },
  { id: 'azure-deep', displayName: 'Azure Deep', kind: 'power', color: 0x4fd0e8, region: 'azure-deep', liveryEdge: 'tongue' },
  { id: 'ancients', displayName: 'The Ancients', kind: 'ancient', color: 0xd8c4ff, liveryEdge: 'swept' },
] as FactionDef[]);

/** The region powers, by region id. */
export const REGION_POWER_IDS: readonly FactionId[] = Object.freeze(['core', 'verdant-reach', 'crimson-expanse', 'azure-deep']);

// ── Minor factions (F2) ─────────────────────────────────────────────────────

const MINOR_NAMES = [
  'Kestrel', 'Halvard', 'Orrin', 'Vesta', 'Tamsin', 'Corvid', 'Brannock', 'Ilex', 'Merrow', 'Saffron',
  'Dunmore', 'Pellan', 'Quillon', 'Ashgrove', 'Thorne', 'Calder', 'Wrexley', 'Marisol', 'Oduya', 'Sorrel',
] as const;
const MINOR_SUFFIX: Readonly<Record<MinorSpecialty, readonly string[]>> = {
  mining: ['Mining Co.', 'Extraction', 'Deepcut'],
  freight: ['Freight', 'Haulage', 'Logistics'],
  manufacturer: ['Works', 'Industries', 'Fabrication'],
  militia: ['Militia', 'Guard', 'Defence Corps'],
};
const MINOR_SPECIALTIES: readonly MinorSpecialty[] = ['mining', 'freight', 'manufacturer', 'militia'];
/** Seed of the minor-faction table. Changing it renames every minor faction. */
const MINOR_SEED = 0x5eed_f2;
export const MINOR_FACTIONS_PER_REGION = 3;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The minor factions: `MINOR_FACTIONS_PER_REGION` per region, each with a
 * different specialty, a unique generated name and a colour. Deterministic
 * (fixed seed), so every process, client or server, agrees on the same ids.
 */
function generateMinorFactions(): FactionDef[] {
  const rnd = mulberry32(MINOR_SEED);
  const names = [...MINOR_NAMES];
  const out: FactionDef[] = [];
  for (const region of REGION_POWER_IDS) {
    const specs = [...MINOR_SPECIALTIES];
    for (let i = 0; i < MINOR_FACTIONS_PER_REGION; i++) {
      const specialty = specs.splice(Math.floor(rnd() * specs.length), 1)[0]!;
      const name = names.splice(Math.floor(rnd() * names.length), 1)[0]!;
      const suffixes = MINOR_SUFFIX[specialty];
      const suffix = suffixes[Math.floor(rnd() * suffixes.length)]!;
      const displayName = `${name} ${suffix}`;
      const id = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
      const hue = Math.floor(rnd() * 360);
      // Livery edge by position, not the seeded stream (drawing from it would
      // rename every minor faction): a region's minors wear all three shapes.
      const liveryEdge = LIVERY_EDGES[i % LIVERY_EDGES.length]!;
      out.push({ id, displayName, kind: 'minor', color: hslToRgb(hue, 0.45, 0.62), region, specialty, liveryEdge });
    }
  }
  return out;
}

function hslToRgb(h: number, s: number, l: number): number {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

/** The generated minor factions (registered with the catalogue on load). */
export const MINOR_FACTIONS: readonly FactionDef[] = Object.freeze(generateMinorFactions());

const NPC_FACTIONS = new Map<FactionId, FactionDef>([...FIXED_FACTIONS, ...MINOR_FACTIONS].map((f) => [f.id, f]));

/** The minor factions working in a region. */
export function minorFactionsOf(region: string): FactionDef[] {
  return MINOR_FACTIONS.filter((f) => f.region === region);
}

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

// ── Standing events (F3) ────────────────────────────────────────────────────

/** A first hit between two factions (one of them a player) lowers the
 *  victim's view of the attacker by this much, once per window per pair. */
export const STANDING_HIT_DELTA = -1;
export const STANDING_HIT_WINDOW_MS = 15_000;
/** Starting a break-in lowers the owner's view of the thief. */
export const STANDING_BREAK_IN_DELTA = -10;

// ── A player's own policy (F3) ──────────────────────────────────────────────

/**
 * The editable part of a player's policy, as sent on the wire. `null` = off
 * (JSON has no Infinity). Turrets fire on anyone the player views below
 * `hostileBelow`; anyone above `alliedAbove` counts as an ally.
 */
export const PlayerPolicyWireSchema = z
  .object({
    hostileBelow: z.number().min(STANDING_MIN).max(0).nullable(),
    alliedAbove: z.number().min(0).max(STANDING_MAX).nullable(),
  })
  .strict();
export type PlayerPolicyWire = z.infer<typeof PlayerPolicyWireSchema>;

export const PLAYER_POLICY_OFF: PlayerPolicyWire = Object.freeze({ hostileBelow: null, alliedAbove: null });

/** The full policy a player's wire settings mean (trade fields stay default). */
export function policyFromWire(w: PlayerPolicyWire): FactionPolicy {
  return {
    ...DEFAULT_FACTION_POLICY,
    hostileBelow: w.hostileBelow ?? -Infinity,
    alliedAbove: w.alliedAbove ?? Infinity,
  };
}

// ── The Factions tab view (F3, `GET /trade/factions`) ───────────────────────

export const FactionRowSchema = z.object({
  factionId: z.string(),
  /** A display name, never a raw id (players resolve to their name). */
  name: z.string(),
  kind: z.enum(['swarm', 'guild', 'power', 'ancient', 'minor', 'player']),
  color: z.number(),
  /** That faction's view of the player. */
  theirView: z.number(),
  /** The player's view of that faction. */
  yourView: z.number(),
});
export type FactionRow = z.infer<typeof FactionRowSchema>;

// ── Ship liveries ───────────────────────────────────────────────────────────

/** FNV-1a 32-bit of a string (unsigned). Local copy: shared-types stays free of core. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The player livery palette: 12 hues 30° apart (offset 15° so none lands on
 * the pure primaries), saturation 0.6, lightness 0.55 — reads on grey hulls.
 */
export const PLAYER_LIVERY: readonly number[] = Object.freeze(
  Array.from({ length: 12 }, (_, i) => hslToRgb(15 + i * 30, 0.6, 0.55)),
);

function liverySlot(id: FactionId): number {
  return fnv1a(id) % PLAYER_LIVERY.length;
}

// ── Claimed looks (colour + sigil pairs) ────────────────────────────────────
//
// A player may claim a unique (palette slot, sigil) pair; the ship sigil seed
// is then `slot << 12 | sigil`, the same 16-bit layout as the hash default,
// so a claim changes nothing downstream but the numbers. Unclaimed players
// keep the hash default. NPC factions never claim, and no claim may take an
// NPC faction's own sigil seed. Module state like `NPC_FACTIONS`: the server
// fills it from the economy store, the client from the Factions reply.

/** Sigils per colour slot (the low 12 bits of the sigil seed). */
export const SIGIL_COUNT = 0x1000;

export interface FactionLook {
  readonly colorSlot: number;
  readonly sigil: number;
}

export const FactionLookWireSchema = z.object({
  factionId: z.string().min(1).max(64),
  colorSlot: z.number().int().min(0).max(PLAYER_LIVERY.length - 1),
  sigil: z.number().int().min(0).max(SIGIL_COUNT - 1),
});
export type FactionLookWire = z.infer<typeof FactionLookWireSchema>;
/** Most claims that can exist (one per pair): the wire bound on a full list. */
export const MAX_FACTION_LOOKS = PLAYER_LIVERY.length * SIGIL_COUNT;

/** The Factions tab reply (`GET /trade/factions`); `looks` is every claimed
 *  look (all players), so every client paints the same pairs. */
export const PlayerFactionsViewSchema = z.object({
  rows: z.array(FactionRowSchema),
  policy: PlayerPolicyWireSchema,
  looks: z.array(FactionLookWireSchema).max(MAX_FACTION_LOOKS).default([]),
});
export type PlayerFactionsView = z.infer<typeof PlayerFactionsViewSchema>;

/** Why a claim failed, or 'ok'. */
export const FACTION_LOOK_CLAIMS = ['ok', 'npc', 'range', 'taken'] as const;
export type FactionLookClaim = (typeof FACTION_LOOK_CLAIMS)[number];

const FACTION_LOOKS = new Map<FactionId, FactionLook>();
/** Packed pair (`slot << 12 | sigil`) → the faction holding it. */
const LOOK_HOLDERS = new Map<number, FactionId>();
let lookVersion = 0;

function packLook(colorSlot: number, sigil: number): number {
  return (colorSlot << 12) | sigil;
}

export function isLookInRange(colorSlot: number, sigil: number): boolean {
  return Number.isInteger(colorSlot) && colorSlot >= 0 && colorSlot < PLAYER_LIVERY.length
    && Number.isInteger(sigil) && sigil >= 0 && sigil < SIGIL_COUNT;
}

/** True when some NPC faction's own sigil seed is this pair. */
function npcHoldsLook(packed: number): boolean {
  for (const id of NPC_FACTIONS.keys()) if ((fnv1a(id) & 0xffff) === packed) return true;
  return false;
}

/** Is this pair free for `forFaction` (its own current claim counts as free)? */
export function isLookFree(colorSlot: number, sigil: number, forFaction?: FactionId): boolean {
  if (!isLookInRange(colorSlot, sigil)) return false;
  const packed = packLook(colorSlot, sigil);
  const holder = LOOK_HOLDERS.get(packed);
  if (holder !== undefined && holder !== forFaction) return false;
  return !npcHoldsLook(packed);
}

/** Claim a pair for a (player) faction; a new claim releases its old pair. */
export function claimFactionLook(id: FactionId, colorSlot: number, sigil: number): FactionLookClaim {
  if (NPC_FACTIONS.has(id)) return 'npc';
  if (!isLookInRange(colorSlot, sigil)) return 'range';
  if (!isLookFree(colorSlot, sigil, id)) return 'taken';
  const old = FACTION_LOOKS.get(id);
  if (old) LOOK_HOLDERS.delete(packLook(old.colorSlot, old.sigil));
  FACTION_LOOKS.set(id, Object.freeze({ colorSlot, sigil }));
  LOOK_HOLDERS.set(packLook(colorSlot, sigil), id);
  lookVersion++;
  return 'ok';
}

/** A faction's claimed look, if it has one. */
export function factionLookOf(id: FactionId): FactionLook | undefined {
  return FACTION_LOOKS.get(id);
}

/** Every claim, for the wire (`PlayerFactionsView.looks`). */
export function factionLooksWire(): FactionLookWire[] {
  const out: FactionLookWire[] = [];
  for (const [factionId, l] of FACTION_LOOKS) out.push({ factionId, colorSlot: l.colorSlot, sigil: l.sigil });
  return out;
}

/** Replace every claim (server hydrate, client apply). Entries that are out of
 *  range, NPC, or clash with an earlier entry are skipped. No-op (no version
 *  bump) when the set is unchanged, so a poller can apply every reply. */
export function setFactionLooks(entries: readonly FactionLookWire[]): void {
  if (entries.length === FACTION_LOOKS.size && entries.every((e) => {
    const l = FACTION_LOOKS.get(e.factionId);
    return l !== undefined && l.colorSlot === e.colorSlot && l.sigil === e.sigil;
  })) return;
  FACTION_LOOKS.clear();
  LOOK_HOLDERS.clear();
  for (const e of entries) claimFactionLook(e.factionId, e.colorSlot, e.sigil);
  lookVersion++;
}

/** Bumped on every change to the claims (render caches key on it). */
export function factionLookVersion(): number {
  return lookVersion;
}

/** The free sigils in a colour slot (for the picker; allocates). */
export function freeSigilsFor(colorSlot: number, forFaction?: FactionId): number[] {
  const out: number[] = [];
  for (let s = 0; s < SIGIL_COUNT; s++) if (isLookFree(colorSlot, s, forFaction)) out.push(s);
  return out;
}

/** The single colour authority for a faction's ships: an NPC faction's own
 *  colour (drones, robots, traders included), else a player's claimed palette
 *  slot, else their hashed slot. */
export function teamColorOf(id: FactionId): number {
  const def = NPC_FACTIONS.get(id);
  if (def) return def.color;
  const look = FACTION_LOOKS.get(id);
  return PLAYER_LIVERY[look ? look.colorSlot : liverySlot(id)]!;
}

/** A 16-bit sigil seed for a faction's ship markings: a player's claimed pair,
 *  else a deterministic hash. */
export function teamSigilOf(id: FactionId): number {
  const h = fnv1a(id);
  if (NPC_FACTIONS.has(id)) return h & 0xffff;
  const look = FACTION_LOOKS.get(id);
  if (look) return packLook(look.colorSlot, look.sigil);
  return ((liverySlot(id) << 12) | ((h >>> 16) & 0x0fff)) & 0xffff;
}

/** A faction's painted-section edge shape (livery 'b8'): an NPC faction's
 *  own, else one derived from a player's claimed sigil, else a stable hash of
 *  the id over `LIVERY_EDGES`. */
export function teamEdgeOf(id: FactionId): LiveryEdge {
  const own = NPC_FACTIONS.get(id)?.liveryEdge;
  if (own) return own;
  const look = FACTION_LOOKS.get(id);
  if (look) return LIVERY_EDGES[look.sigil % LIVERY_EDGES.length]!;
  return LIVERY_EDGES[(fnv1a(id) >>> 8) % LIVERY_EDGES.length]!;
}
