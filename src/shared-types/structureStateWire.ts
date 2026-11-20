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

/** `StructureState.flags` bits. The field is a uint16: it was a uint8 until
 *  the eight bits ran out at BREACH. */
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
/** C2 — someone is breaking into this structure's cargo right now. */
export const STRUCTURE_FLAG_BREACH = 128;
/** F2 — a built Territory Lock whose owner's side holds its sector right now
 *  (its beacon dish turns only then). Derived on every sync, never an event,
 *  so a late joiner reads it from the row (#16). */
export const STRUCTURE_FLAG_LOCK_HOLDING = 256;
/** The owner switched this structure Off (no draw, no work). */
export const STRUCTURE_FLAG_OFF = 512;
/** The owner's power throttle rides bits 10-13 of `flags` as the tenths
 *  BELOW full (0 = 100%, the default, so an unthrottled row sends no bits;
 *  10 = 0%). No new schema field. Both sides use these helpers (#15). */
const STRUCTURE_THROTTLE_SHIFT = 10;
const STRUCTURE_THROTTLE_MASK = 0xf;

/** The `flags` bits for a throttle of `tenths` (0..10; out of range clamps). */
export function encodeStructureThrottleFlags(tenths: number): number {
  const t = Math.max(0, Math.min(10, Math.round(tenths)));
  return (10 - t) << STRUCTURE_THROTTLE_SHIFT;
}

/** The throttle (tenths, 0..10) a `flags` value carries. */
export function decodeStructureThrottleFlags(flags: number): number {
  return Math.max(0, 10 - ((flags >> STRUCTURE_THROTTLE_SHIFT) & STRUCTURE_THROTTLE_MASK));
}

/** `StructureState.etaMs` sentinels: ≥ 0 is a real ETA. */
export const STRUCTURE_ETA_NONE = -1;
export const STRUCTURE_ETA_STALLED = -2;

/** Coastal defences — `SnapshotMessage.structureMountAngles` carries each
 *  angle in milliradians (±π fits easily; 1 mrad is 5 u at 5,000 u). */
export const MOUNT_ANGLE_QUANTUM = 1000;

/**
 * Append one structure's mount angles to the flat `structureMountAngles` run
 * `[entityId, count, q0, …]` at `at`; returns the new length. A structure
 * whose every mount rests (all 0 after quantising) is skipped, so a quiet base
 * costs nothing. Server side; writes into a reused array (#14).
 */
export function encodeStructureMountAngles(out: number[], at: number, entityId: number, angles: ArrayLike<number>): number {
  let any = false;
  for (let i = 0; i < angles.length; i++) if (Math.round(angles[i]! * MOUNT_ANGLE_QUANTUM) !== 0) { any = true; break; }
  if (!any) return at;
  out[at++] = entityId;
  out[at++] = angles.length;
  for (let i = 0; i < angles.length; i++) out[at++] = Math.round(angles[i]! * MOUNT_ANGLE_QUANTUM);
  return at;
}

/** Walk a `structureMountAngles` run: `visit(entityId, flat, start, count)`
 *  for each structure, its angles being `flat[start + k] / MOUNT_ANGLE_QUANTUM`. */
export function forEachStructureMountAngles(
  flat: readonly number[], visit: (entityId: number, flat: readonly number[], start: number, count: number) => void,
): void {
  let i = 0;
  while (i + 1 < flat.length) {
    const count = flat[i + 1]!;
    visit(flat[i]!, flat, i + 2, count);
    i += 2 + count;
  }
}

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
  tpPhase: 0,
  tpPhaseMs: 0,
  tpChargePct: 0,
  tpPartner: -1,
  tpRules: 0,
  tpLoadGood: 0,
  tpLoadQty: 0,
  tpKeepGood: 0,
  tpKeepQty: 0,
  padWeight: 0,
  tpToll: 0,
  rigClip: 0,
  rigStart: 0,
  rigTx: 0,
  rigTy: 0,
  rigHold: 0,
  prodCount: 0,
} as const;

/**
 * Structure-restyle 0d slice 6 — `StructureState.connSock`, parallel to
 * `connTo`: per link, the cable socket at THIS end (low byte) and at the OTHER
 * end (high byte), each an index into `structureSockets(kind)`, with
 * `CONN_SOCK_NONE` (255) for "no socket" (a fence link, `CABLE_NO_SOCKET` = -1
 * in core). A uint16, not a uint8 holding two nibbles: kinds reach 24 sockets
 * (teleporter_large), past a nibble's 15. Both ends ride each row so the client
 * draws a cable from one row alone (no cross-row lookup, no ordering hazard
 * between the two rows' patches). Static per link, so the cost is the join
 * payload plus one patch when links change: 2 B per link end.
 */
export const CONN_SOCK_NONE = 255;

/** One byte of a `connSock` entry: a socket index 0..254, anything else none. */
function connSockByte(socket: number): number {
  return socket >= 0 && socket < CONN_SOCK_NONE && Number.isInteger(socket) ? socket : CONN_SOCK_NONE;
}

/** Pack this end's and the other end's socket indices (-1 = no socket). */
export function encodeConnSock(self: number, other: number): number {
  return connSockByte(self) | (connSockByte(other) << 8);
}

/** This end's socket index from a `connSock` entry, or -1 for none. */
export function decodeConnSockSelf(v: number): number {
  const b = v & 0xff;
  return b === CONN_SOCK_NONE ? -1 : b;
}

/** The other end's socket index from a `connSock` entry, or -1 for none. */
export function decodeConnSockOther(v: number): number {
  const b = (v >> 8) & 0xff;
  return b === CONN_SOCK_NONE ? -1 : b;
}

/** `connSock` value for an entry the row lacks (an older or partial row):
 *  both ends unknown, drawn as a straight link. */
export const CONN_SOCK_UNKNOWN = CONN_SOCK_NONE | (CONN_SOCK_NONE << 8);

/**
 * Structure-restyle 2e — the rig clip playing on a structure rides its
 * room-state row (late-join safe, invariant #16). `rigClip` packs the clip as
 * its index in the rig's clip list + 1 (0 = no clip: the rig rests) in the low
 * 7 bits, plus `STRUCTURE_RIG_CLIP_TARGET` when `rigTx` / `rigTy` (float32,
 * host frame) carry a target. `rigStart` is the server tick the clip started
 * on. Both sides use these helpers (#15).
 */
export const STRUCTURE_RIG_CLIP_TARGET = 0x80;
const RIG_CLIP_INDEX_MASK = 0x7f;

/** The `rigClip` byte for clip index `clipIndex` (-1 = none). */
export function encodeRigClip(clipIndex: number, hasTarget: boolean): number {
  if (clipIndex < 0) return 0;
  if (clipIndex >= RIG_CLIP_INDEX_MASK) throw new Error(`rig clip index ${clipIndex} does not fit the wire byte`);
  return (clipIndex + 1) | (hasTarget ? STRUCTURE_RIG_CLIP_TARGET : 0);
}

/** The clip index a `rigClip` byte names, or -1 (no clip). */
export function decodeRigClipIndex(v: number): number {
  return (v & RIG_CLIP_INDEX_MASK) - 1;
}

/**
 * Structure-restyle 3e — a holding clip's hold length (ticks, low 12 bits)
 * and the direction of the cargo the arm carries during it
 * (`CRANE_CARGO_*`, bits 12-13) ride the same row as `rigHold` (0 = no
 * hold), so every client times the cargo from the clip already on the wire.
 * Both sides use these helpers (#15).
 */
const RIG_HOLD_TICKS_MASK = 0x0fff;
const RIG_HOLD_CARGO_SHIFT = 12;

/** The `rigHold` value for a hold of `holdTicks` moving `cargo`. */
export function encodeRigHold(holdTicks: number, cargo: number): number {
  const t = Math.max(0, Math.min(RIG_HOLD_TICKS_MASK, Math.round(holdTicks)));
  return t === 0 ? 0 : t | ((cargo & 3) << RIG_HOLD_CARGO_SHIFT);
}

/** The hold length (ticks) a `rigHold` value carries (0 = none). */
export function decodeRigHoldTicks(v: number): number {
  return v & RIG_HOLD_TICKS_MASK;
}

/** The cargo direction a `rigHold` value carries (0 = none). */
export function decodeRigHoldCargo(v: number): number {
  return (v >> RIG_HOLD_CARGO_SHIFT) & 3;
}

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
  /** v4 T1 — teleporters (encodings in shared-types/teleport.ts). */
  tpPhase?: number;
  tpPhaseMs?: number;
  tpChargePct?: number;
  tpPartner?: number;
  tpRules?: number;
  tpLoadGood?: number;
  tpLoadQty?: number;
  tpKeepGood?: number;
  tpKeepQty?: number;
  padWeight?: number;
  tpToll?: number;
  /** Structure-restyle 2e — the playing rig clip (`encodeRigClip`), its start
   *  tick and its host-frame target. */
  rigClip?: number;
  rigStart?: number;
  rigTx?: number;
  rigTy?: number;
  /** Structure-restyle 3e — a holding clip's length and cargo direction
   *  (`encodeRigHold`); 0 = none. */
  rigHold?: number;
  /** Build count (job 2E): `encodeProdCount` (shared-types/production.ts). */
  prodCount?: number;
  connTo: { readonly length: number; at(i: number): number | undefined };
  /** 0d slice 6 — per `connTo` entry, the packed socket pair
   *  (`encodeConnSock`). Optional so a row without it reads as no sockets. */
  connSock?: { readonly length: number; at(i: number): number | undefined };
}
