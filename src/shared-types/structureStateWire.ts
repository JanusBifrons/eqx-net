/**
 * Structure room-state wire contract (plan soft-leaping-truffle v2, A2).
 *
 * Structure grid state lives in Colyseus room state (`SectorState.structures`,
 * keyed by entityId) as quantised fields; only fast cosmetics (turret / mining
 * targets) ride the snapshot as `structureTargets`. These constants are the
 * ONE definition both sides read (invariant #15): the server packs, the client
 * (`src/client/net/structureStateDecode.ts`) unpacks into `mirror.structures`.
 */

/**
 * Binary pose channel (A2): a SLEEPING structure outside a client's interest
 * window rides only every Nth full refresh (full refreshes are once per
 * second), instead of every one. Structures are static, so their pose never
 * goes stale; the room-state row (not the full-refresh sweep) owns a
 * structure's lifetime on the client. A0 measured the every-second resend at
 * ~15 KB/s per client for a citadel.
 */
export const STRUCTURE_OUT_OF_INTEREST_FULL_EVERY = 5;

/** `StructureState.flags` bits. */
export const STRUCTURE_FLAG_BUILT = 1;
export const STRUCTURE_FLAG_POWERED = 2;
export const STRUCTURE_FLAG_DECONSTRUCTING = 4;
/** A shield emitter's walls are up: it has at least one wall and every one of
 *  them is powered and not stunned (gates: the shield, not the open state). */
export const STRUCTURE_FLAG_WALL_ACTIVE = 8;
/** P2d — an ammo-using turret found no munitions for its last shot. */
export const STRUCTURE_FLAG_NO_AMMO = 16;
/** D1 — a built Reactor has no fuel (it produces no power). */
export const STRUCTURE_FLAG_NO_FUEL = 32;
/** Active power: the structure is drawing its full consumption this pulse
 *  (otherwise the idle trickle, `structurePower.ts`). */
export const STRUCTURE_FLAG_DRAW_FULL = 64;

/** `StructureState.etaMs` sentinels: ≥ 0 is a real ETA. */
export const STRUCTURE_ETA_NONE = -1;
export const STRUCTURE_ETA_STALLED = -2;

/** `SnapshotMessage.structureTargets` is flat triples
 *  `[structureEntityId, turretTargetEntityId, miningTargetEntityId]`, with
 *  `-1` for "no target". */
export const STRUCTURE_TARGET_STRIDE = 3;
export const STRUCTURE_TARGET_NONE = -1;

/**
 * B2 (plan soft-leaping-truffle v3) — a turret can target a PLAYER, who has no
 * swarm entity id. The turret slot then holds `-(ownerIdx + 2)`, where
 * `ownerIdx` indexes the room-state `structureOwners` table (the server
 * interns the target player there). Both sides use these two helpers (#15).
 */
export function encodePlayerTurretTarget(ownerIdx: number): number {
  return -(ownerIdx + 2);
}

/** The owner-table index a turret slot points at, or -1 when it is a swarm
 *  entity id or `STRUCTURE_TARGET_NONE`. */
export function decodePlayerTurretTarget(v: number): number {
  return v <= -2 ? -v - 2 : -1;
}

/** Value of a room-state structure field that is UNSET (never encoded). */
export const STRUCTURE_DEFAULTS = {
  ownerIdx: 0,
  flags: 0,
  hpPct: 100,
  level: 1,
  netPower: 0,
  minerals: 0,
  buildPct: 0,
  etaMs: STRUCTURE_ETA_NONE,
  deconstructPct: 0,
  storedPower: 0,
  storedPowerMax: 0,
  shieldWallTo: -1,
  gateOpen: 0,
  gateAccess: 0,
  recipe: 0,
  prodState: 0,
  prodMissing: 0,
  bpRuns: 0,
  bpQuality: 0,
} as const;

/** The fields the client reads from a room-state structure row (absent ⇒
 *  STRUCTURE_DEFAULTS). */
export interface StructureStateView {
  /** Index into the sector's interned owner tables. */
  ownerIdx?: number;
  flags?: number;
  hpPct?: number;
  level?: number;
  netPower?: number;
  minerals?: number;
  buildPct?: number;
  etaMs?: number;
  deconstructPct?: number;
  storedPower?: number;
  storedPowerMax?: number;
  shieldWallTo?: number;
  /** Gates: GATE_OPEN_A / GATE_OPEN_B bits (core/structures/gateLogic.ts). */
  gateOpen?: number;
  /** Gates: GATE_ACCESS_IDS index (shared-types/gateAccess.ts). */
  gateAccess?: number;
  /** Production (P2b): encodings in shared-types/production.ts. */
  recipe?: number;
  prodState?: number;
  prodMissing?: number;
  bpRuns?: number;
  bpQuality?: number;
  connTo: { readonly length: number; at(i: number): number | undefined };
}
