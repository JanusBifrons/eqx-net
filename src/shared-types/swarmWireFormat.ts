/**
 * Binary swarm packet — wire format shared by server encoder and client decoder.
 *
 * Layout (little-endian, fixed strides for branch-free decode):
 *
 * Header (8 bytes):
 *   [0]  u8   version
 *   [1]  u8   flags     (bit 0 = full snapshot, bit 1 = decimated)
 *   [2]  u16  count     (number of records)
 *   [4]  u32  serverTick
 *
 * Per-entity record (34 bytes — v4):
 *   [+0]  u16  entityId      (dense 0..65535)
 *   [+2]  u8   kind          (0=asteroid, 1=drone, 2=structure, 3=scrap)
 *   [+3]  u8   recordFlags   (bit 0 = SLEEPING, bit 1 = SHIELD_DOWN)
 *   [+4]  f32  x
 *   [+8]  f32  y
 *   [+12] f32  vx
 *   [+16] f32  vy
 *   [+20] f32  angle
 *   [+24] f32  angvel        (v3: angular velocity — required for client AI lockstep.
 *                             v2 omitted this; client AI's torque-damping term used a
 *                             different `self.angvel` than the server, so drone bearing
 *                             diverged every tick and packet snaps drove visible jitter.)
 *   [+28] f32  radius        (collision radius — needed by client renderer + server hitscan)
 *   [+32] u8   shipKind      (shared subtype byte. kind=drone → index into `SHIP_KINDS_LIST`;
 *                             kind=structure → index into `STRUCTURE_KINDS_LIST`;
 *                             kind=scrap → the PARENT ship-kind index into `SHIP_KINDS_LIST`
 *                             (the composite the scrap broke off of, drives its sub-shape
 *                             palette); 0 / ignored for asteroids. Catalogue indices are
 *                             APPEND-ONLY — reordering invalidates this for in-flight packets.)
 *   [+33] u8   componentIndex (v4: scrap-component index — meaningful ONLY when kind=scrap,
 *                             0 otherwise. Selects WHICH scrap group of the parent ship-kind
 *                             this piece is — the index into `shipScrapGroups(parentKind)`.)
 *
 * Sleeping entities ship one packet on the sleep-transition tick (recordFlags
 * bit 0 set, vx/vy = 0, angvel = 0), then drop out entirely until they wake.
 *
 * **Version contract**: a decoder that sees `version !== SWARM_WIRE_VERSION`
 * MUST drop the packet (and ideally surface a "please refresh" banner). Older
 * clients reading v4 with the v3 stride mis-attribute every byte after the
 * first record — never silently fall back. v3 had a 33-byte record without the
 * trailing componentIndex byte; v2 had a 29-byte record without the embedded
 * angvel field; v1 had 28 bytes without shipKind.
 */

export const SWARM_WIRE_VERSION = 4;

export const SWARM_HEADER_BYTES = 8;
export const SWARM_RECORD_BYTES = 34;
/** Offset of the angvel f32 within a record (v3). */
export const SWARM_REC_ANGVEL_OFF = 24;
/** Offset of the radius f32 within a record (v3 — shifted from v2's +24). */
export const SWARM_REC_RADIUS_OFF = 28;
/** Offset of the `shipKind` byte within a record (v3 — shifted from v2's +28). Index into `SHIP_KINDS_LIST`. */
export const SWARM_REC_SHIP_KIND_OFF = 32;
/** Offset of the `componentIndex` u8 within a record (v4 — NEW trailing byte).
 *  Meaningful ONLY when `kind === SWARM_KIND_SCRAP`; 0 for every other kind.
 *  Selects which `shipScrapGroups(parentKind)` group this scrap piece is. */
export const SWARM_REC_COMPONENT_INDEX_OFF = 33;

export const SWARM_FLAG_FULL = 1 << 0;
export const SWARM_FLAG_DECIMATED = 1 << 1;

export const SWARM_RECORD_FLAG_SLEEPING = 1 << 0;
/** Phase: shield — set while a drone's shield is at 0 (hull exposed).
 *  Spare bit in the existing recordFlags byte: NO stride change, NO
 *  SWARM_WIRE_VERSION bump. */
export const SWARM_RECORD_FLAG_SHIELD_DOWN = 1 << 1;

export const SWARM_KIND_ASTEROID = 0;
export const SWARM_KIND_DRONE = 1;
/** Generic Entity Pipeline P4 — a static, damageable world STRUCTURE. A new
 *  pose-core `kind` BYTE value only: NO stride change, NO `SWARM_WIRE_VERSION`
 *  bump (the kind field is a free u8; the decoder reads any value). It rides
 *  the existing binary encoder/broadcast/interest path for free; the client
 *  routes it via `swarmKindClientProfile`. Kinds are append-only. */
export const SWARM_KIND_STRUCTURE = 2;
/** Scrap-on-death (Phase 2a) — a damageable salvage piece shed by a composite
 *  ship on death. Rides the pose-core binary channel like every other swarm
 *  kind (NO new continuous field — the v4 bump is purely the trailing
 *  componentIndex u8). The shared `shipKind` byte at +32 carries the PARENT
 *  ship-kind index (the composite it broke off of); the new componentIndex u8
 *  at +33 selects which `shipScrapGroups(parentKind)` group this piece is.
 *  Kinds are append-only (invariant #11). */
export const SWARM_KIND_SCRAP = 3;

/** Maximum number of records that fit in a buffer of `bufBytes` total bytes. */
export function swarmRecordCapacity(bufBytes: number): number {
  return Math.floor((bufBytes - SWARM_HEADER_BYTES) / SWARM_RECORD_BYTES);
}

/** Byte size for `count` records plus the header. */
export function swarmPacketSize(count: number): number {
  return SWARM_HEADER_BYTES + count * SWARM_RECORD_BYTES;
}
