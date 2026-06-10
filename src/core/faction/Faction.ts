/**
 * Faction — pure, zone-blind rules for the wave-attack faction model
 * (wave-system plan, Phase 1).
 *
 * A faction is "a player + the structures they own in one sector" (the
 * per-(owner, sector) granularity the server `FactionLedger` enforces — see
 * `src/server/faction/FactionLedger.ts`). The drones are the opposing side.
 *
 * This module owns the deterministic DECISIONS over faction state — when a
 * besieged faction de-escalates, and whether a base is "ready" enough to draw
 * a wave. It holds no I/O, no registry, no timers: the server service feeds it
 * counts + ticks and acts on the booleans. Keeping the rules pure is what lets
 * them be exhaustively unit-tested (truth tables + boundaries) and lets a
 * future difficulty pass add a new predicate without touching the server.
 */

/** Per-tick (60 Hz) window a faction must go without dealing ANY damage to a
 *  drone before a wave can de-escalate. 60 s — long enough that a player still
 *  trading fire stays "at war", short enough that abandoning the fight ends it
 *  in a reasonable time. Tunable; difficulty passes may shorten/lengthen it. */
export const FACTION_PEACEFUL_TIMEOUT_TICKS = 3600;

/** Mutable per-faction state owned by the server `FactionLedger`. */
export interface FactionState {
  /** Faction id == the owning player's id (one faction per owner, per sector). */
  readonly id: string;
  /** True once any faction member (player ship or owned structure) has damaged
   *  a drone, OR a wave has been declared against the faction. Drones treat the
   *  whole faction as valid targets while this holds. */
  hostileToDrones: boolean;
  /** Server tick at which a faction member last dealt damage to a drone. The
   *  de-escalation peaceful-timeout anchor. `-Infinity` ⇒ never. */
  lastDealtDamageTick: number;
  /** True while the director has an active wave assigned against this faction.
   *  Gates the drone-AI structure-target visibility (Phase 2 scratch build). */
  underWave: boolean;
}

/** Fresh state for a newly-observed faction (peaceful, no wave). */
export function createFactionState(id: string): FactionState {
  return { id, hostileToDrones: false, lastDealtDamageTick: -Infinity, underWave: false };
}

/** Inputs to the de-escalation decision (all server-supplied). */
export interface DeEscalationInputs {
  /** Count of the faction's surviving, constructed Miners. */
  minerCount: number;
  /** Current server tick. */
  nowTick: number;
  /** Peaceful window in ticks (defaults to `FACTION_PEACEFUL_TIMEOUT_TICKS`). */
  peacefulTimeoutTicks: number;
}

/**
 * Should an active wave against this faction STOP? True iff the faction has NO
 * surviving Miners AND has dealt no damage to a drone for the peaceful window.
 * Both conditions are required (req #8): a player still shooting drones keeps
 * the war alive even with no miners; miners alive keeps it alive even if peaceful.
 */
export function shouldDeEscalate(state: FactionState, inputs: DeEscalationInputs): boolean {
  if (inputs.minerCount > 0) return false;
  return inputs.nowTick - state.lastDealtDamageTick > inputs.peacefulTimeoutTicks;
}

/** Structure counts for the base-readiness decision. */
export interface BaseComposition {
  hasCapital: boolean;
  minerCount: number;
  solarCount: number;
  turretCount: number;
}

/**
 * Is a faction's base built up enough to start drawing waves (req #3)? A
 * constructed Capital (the core) + at least one Miner (something to defend) +
 * at least one Solar (power) + at least one Turret (defence). The server
 * computes the counts over constructed (and ideally powered) structures; the
 * threshold itself is this one pure predicate so a difficulty pass can tighten
 * it (e.g. ≥2 turrets) without editing the director.
 */
export function isBaseReady(c: BaseComposition): boolean {
  return c.hasCapital && c.minerCount >= 1 && c.solarCount >= 1 && c.turretCount >= 1;
}
