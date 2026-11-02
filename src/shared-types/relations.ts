/**
 * Relations (plan soft-leaping-truffle v3, phase B1) — the ONE answer to
 * "what is this actor to the owner of that thing?". Gates, turrets, cargo
 * access and break-ins all ask through `relationOf`, so no two systems can
 * disagree about who is hostile (invariant #15).
 *
 * A PARTY is an owner string, used for both sides of the question:
 *  - a player (or account) id, e.g. a UUID, or the test owner `scenario`;
 *  - an NPC side, `npc:<allegiance>`, e.g. `npc:robots` for a roaming robot;
 *  - an NPC base, `npc:<allegiance>:<baseId>`, e.g. `npc:traders:sol-3`.
 * Persistence and uid hashing treat owner strings as opaque, so NPC owners
 * need no migration.
 *
 * Pure. The changing inputs come from injected providers: alliances (none
 * today), the hostile-act ledger (`src/core/relations/HostileActLedger.ts`)
 * and an optional NPC-stance override (e.g. a robot truce earned through
 * reputation, B2).
 */
import { PLAYERS_SIDE, stanceOf, type NpcAllegianceId, type Stance } from './allegiances.js';
import {
  defaultFactionPolicy,
  factionStance,
  isNpcFactionId,
  npcFactionDef,
  policyActsOnStanding,
  type FactionId,
  type FactionPolicy,
} from './factions.js';

/** What an actor is to an owner, from closest to worst. */
export type Relation = 'self' | 'friendly' | 'allied' | 'neutral' | 'hostile';

/** How long a hostile act (a break-in, a raid on a base) keeps the actor
 *  hostile to that owner. A balance knob. */
export const HOSTILE_ACT_COOLDOWN_MS = 10 * 60_000;

/** Prefix of NPC owner strings. */
export const NPC_OWNER_PREFIX = 'npc:';

export interface PartyRef {
  readonly kind: 'player' | 'npc';
  /** Player: the id. NPC: the full owner string. */
  readonly id: string;
  /** The party's faction: the NPC faction id, or a player's own id (a player
   *  is a faction of one until player factions exist). */
  readonly faction: FactionId;
  /** NPC only: the faction's allegiance stance side, if it has one. */
  readonly allegiance: NpcAllegianceId | null;
  /** NPC base only ('' for a roaming NPC side). */
  readonly baseId: string;
}

/** Player alliances. None exist yet; player alliances plug in here later. */
export interface AllianceProvider {
  areAllied(a: string, b: string): boolean;
}
export const NO_ALLIANCES: AllianceProvider = { areAllied: () => false };

/** Read side of the hostile-act ledger. */
export interface HostileActQuery {
  /** Has `actor` committed a hostile act against `owner` that hasn't cooled down? */
  isHostile(actor: string, owner: string, nowMs: number): boolean;
}

/**
 * Inputs to `relationOf`. Callers keep ONE context object and update `nowMs`
 * in place, so a hot loop allocates nothing (invariant #14).
 */
export interface RelationContext {
  nowMs: number;
  alliances: AllianceProvider;
  hostileActs: HostileActQuery | null;
  /** Override the stance table between an NPC side and a player (e.g. a robot
   *  truce from reputation). Return undefined to use the table. */
  npcStanceToPlayer: ((allegiance: NpcAllegianceId, playerId: string) => Stance | undefined) | null;
  /** The standing web (factions F1): `from`'s view of `to`, −100..100. Null ⇒
   *  standing never changes a relation. */
  standing: StandingQuery | null;
  /** A faction's policy; null ⇒ the catalogue defaults. */
  policyOf: ((faction: FactionId) => FactionPolicy) | null;
}

/** Read side of the standing web. */
export interface StandingQuery {
  of(from: FactionId, to: FactionId): number;
}

export function createRelationContext(partial?: Partial<RelationContext>): RelationContext {
  return {
    nowMs: partial?.nowMs ?? 0,
    alliances: partial?.alliances ?? NO_ALLIANCES,
    hostileActs: partial?.hostileActs ?? null,
    npcStanceToPlayer: partial?.npcStanceToPlayer ?? null,
    standing: partial?.standing ?? null,
    policyOf: partial?.policyOf ?? null,
  };
}

/** Owner strings are a small, repeating set (players + bases), so parses are
 *  cached; a relation query on a hot path then allocates nothing. Cleared when
 *  it grows past the cap so a long-lived process can't leak. */
const PARSE_CACHE = new Map<string, PartyRef>();
const PARSE_CACHE_MAX = 4096;

/** The owner string for an NPC faction or one of its bases. */
export function npcOwner(faction: FactionId, baseId?: string): string {
  return baseId ? `${NPC_OWNER_PREFIX}${faction}:${baseId}` : `${NPC_OWNER_PREFIX}${faction}`;
}

/** Parse an owner (or actor) string. A malformed `npc:` string (unknown
 *  faction) is treated as a plain player-style id, never as an NPC side. */
export function parseOwner(owner: string): PartyRef {
  const hit = PARSE_CACHE.get(owner);
  if (hit) return hit;
  let ref: PartyRef = { kind: 'player', id: owner, faction: owner, allegiance: null, baseId: '' };
  if (owner.startsWith(NPC_OWNER_PREFIX)) {
    const rest = owner.slice(NPC_OWNER_PREFIX.length);
    const colon = rest.indexOf(':');
    const faction = colon < 0 ? rest : rest.slice(0, colon);
    if (isNpcFactionId(faction)) {
      const allegiance = npcFactionDef(faction)?.allegiance ?? null;
      ref = { kind: 'npc', id: owner, faction, allegiance, baseId: colon < 0 ? '' : rest.slice(colon + 1) };
    }
  }
  if (PARSE_CACHE.size >= PARSE_CACHE_MAX) PARSE_CACHE.clear();
  PARSE_CACHE.set(owner, ref);
  return ref;
}

export function isNpcOwner(owner: string): boolean {
  return parseOwner(owner).kind === 'npc';
}

const RANK: Readonly<Record<Stance, number>> = { friendly: 0, neutral: 1, hostile: 2 };

function stanceToRelation(s: Stance): Relation {
  return s === 'friendly' ? 'friendly' : s === 'hostile' ? 'hostile' : 'neutral';
}

/** The worse of the two directions: hostility is treated as mutual (a robot is
 *  kept out of a player's gate because robots attack players on sight). */
function worse(a: Stance, b: Stance): Stance {
  return RANK[a] >= RANK[b] ? a : b;
}

function npcToPlayer(npc: PartyRef, playerId: string, ctx: RelationContext): Stance {
  if (npc.allegiance !== null) {
    const override = ctx.npcStanceToPlayer?.(npc.allegiance, playerId);
    if (override !== undefined) return override;
    return worse(stanceOf(npc.allegiance, PLAYERS_SIDE), stanceOf(PLAYERS_SIDE, npc.allegiance));
  }
  return worse(factionStance(npc.faction, playerId), factionStance(playerId, npc.faction));
}

/**
 * The owner faction's policy applied to its view of the actor: below
 * `hostileBelow` → hostile; above `alliedAbove` a neutral party becomes
 * allied. It never softens a hostile base relation. Allocation-free.
 */
function applyPolicy(base: Relation, actor: PartyRef, owner: PartyRef, ctx: RelationContext): Relation {
  if (base === 'hostile' || ctx.standing === null || actor.faction === owner.faction) return base;
  const policy = ctx.policyOf?.(owner.faction) ?? defaultFactionPolicy(owner.faction);
  if (!policyActsOnStanding(policy)) return base;
  const v = ctx.standing.of(owner.faction, actor.faction);
  if (v < policy.hostileBelow) return 'hostile';
  if (base === 'neutral' && v > policy.alliedAbove) return 'allied';
  return base;
}

/**
 * What `actor` is to `owner`.
 *  1. The same party → 'self'.
 *  2. A hostile act that hasn't cooled down → 'hostile' (beats any alliance).
 *  3. Two players → 'allied' if the alliance provider says so, else 'neutral'.
 *  4. Two NPC parties → 'friendly' in the same faction, else the stance table.
 *  5. A player and an NPC party → the stance table (the worse direction),
 *     unless `npcStanceToPlayer` overrides it.
 *  6. Then the owner's faction policy reads its standing toward the actor and
 *     may make the relation hostile (or a neutral one allied). With no
 *     standing web, or default policies, nothing changes.
 * An empty owner (an unowned thing) is 'neutral' to everyone.
 */
export function relationOf(actor: string, owner: string, ctx: RelationContext): Relation {
  if (actor === owner) return 'self';
  if (owner === '' || actor === '') return 'neutral';
  if (ctx.hostileActs?.isHostile(actor, owner, ctx.nowMs) === true) return 'hostile';
  const a = parseOwner(actor);
  const o = parseOwner(owner);
  let base: Relation;
  if (a.kind === 'player' && o.kind === 'player') {
    base = ctx.alliances.areAllied(a.id, o.id) ? 'allied' : 'neutral';
  } else if (a.kind === 'npc' && o.kind === 'npc') {
    base = a.faction === o.faction
      ? 'friendly'
      : stanceToRelation(worse(factionStance(a.faction, o.faction), factionStance(o.faction, a.faction)));
  } else {
    const npc = a.kind === 'npc' ? a : o;
    const player = a.kind === 'npc' ? o : a;
    base = stanceToRelation(npcToPlayer(npc, player.id, ctx));
  }
  return applyPolicy(base, a, o, ctx);
}

/** Who may open an owner's cargo without breaking in (C1). Friendly opens;
 *  allied opens only when the owner allows it; anyone else must break in. */
export function cargoOpensFor(relation: Relation, alliesMayOpen: boolean): boolean {
  if (relation === 'self' || relation === 'friendly') return true;
  if (relation === 'allied') return alliesMayOpen;
  return false;
}
