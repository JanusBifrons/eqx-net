/**
 * Allegiances — the NPC "sides" of the living world (plan: peppy-jumping-pinwheel, P0).
 *
 * NAMING: the word "faction" is already taken in this codebase — `src/core/faction/`
 * + `FactionLedger` mean "a player + the structures they own in one sector". The
 * AI sides (drones, robots, traders) are therefore called ALLEGIANCES.
 *
 * Pure data, shared by server + client + core (invariant #15: the stance table
 * is the ONE source both sides read, so a robot that the server treats as
 * on-sight hostile also renders hostile on the client).
 *
 * An NPC ship's allegiance is derived from its ship KIND (`ShipKind.allegiance`,
 * default `'drones'`), so it costs zero wire bytes — the client already knows
 * the kind from the binary swarm record's `shipKind` byte.
 */

/** The NPC allegiances. Append-only (persisted in director state / audit). */
export const NPC_ALLEGIANCE_IDS = ['drones', 'robots', 'traders'] as const;
export type NpcAllegianceId = (typeof NPC_ALLEGIANCE_IDS)[number];

/** Every player (and every player-owned structure) sits on the PLAYERS side
 *  for stance purposes. Player-vs-player is governed by player choice, not by
 *  this table. */
export const PLAYERS_SIDE = 'players' as const;
export type AllegianceSide = NpcAllegianceId | typeof PLAYERS_SIDE;

export interface AllegianceDef {
  readonly id: NpcAllegianceId;
  readonly displayName: string;
  /** Tint used by the radar / galaxy map for this allegiance. */
  readonly color: number;
  /** Whether players can build reputation with this allegiance (P2). */
  readonly repEnabled: boolean;
}

export const ALLEGIANCE_DEFS: Readonly<Record<NpcAllegianceId, AllegianceDef>> = Object.freeze({
  drones: { id: 'drones', displayName: 'Drones', color: 0xff4444, repEnabled: true },
  robots: { id: 'robots', displayName: 'Robots', color: 0xc070ff, repEnabled: true },
  traders: { id: 'traders', displayName: 'Traders', color: 0xffd060, repEnabled: true },
});

/**
 * What side `a` does to side `b` UNPROVOKED.
 *  - `hostile`  — attacks on sight.
 *  - `neutral`  — ignores it unless provoked (the reactive `markHostile`
 *                  ledger still applies — e.g. drones vs players, where waves
 *                  and retaliation drive hostility).
 *  - `friendly` — never targets it (same side).
 */
export type Stance = 'friendly' | 'neutral' | 'hostile';

const STANCE: Readonly<Record<AllegianceSide, Readonly<Record<AllegianceSide, Stance>>>> = {
  drones: { drones: 'friendly', robots: 'hostile', traders: 'neutral', players: 'neutral' },
  robots: { drones: 'hostile', robots: 'friendly', traders: 'hostile', players: 'hostile' },
  traders: { drones: 'neutral', robots: 'neutral', traders: 'friendly', players: 'neutral' },
  players: { drones: 'neutral', robots: 'neutral', traders: 'neutral', players: 'neutral' },
};

export function stanceOf(a: AllegianceSide, b: AllegianceSide): Stance {
  return STANCE[a][b];
}

/** True when `a` attacks `b` on sight (no provocation needed). */
export function isOnSightHostile(a: AllegianceSide, b: AllegianceSide): boolean {
  return STANCE[a][b] === 'hostile';
}

/** True when `a` and `b` are the same side (never target each other). */
export function isFriendly(a: AllegianceSide, b: AllegianceSide): boolean {
  return STANCE[a][b] === 'friendly';
}

export function isNpcAllegianceId(s: string): s is NpcAllegianceId {
  return (NPC_ALLEGIANCE_IDS as readonly string[]).includes(s);
}

/** Distance (world units) inside which an on-sight-hostile NPC engages. Kept
 *  inside the interest window (2048-u cells, 3×3) so a fight a player can see
 *  is a fight the server is simulating with them in view. */
export const ON_SIGHT_ENGAGE_RANGE = 1600;
