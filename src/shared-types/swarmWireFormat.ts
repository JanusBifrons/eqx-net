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
 * Per-entity record (33 bytes — v3):
 *   [+0]  u16  entityId      (dense 0..65535)
 *   [+2]  u8   kind          (0=asteroid, 1=drone)
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
 *   [+32] u8   shipKind      (index into `SHIP_KINDS_LIST`; meaningful only when kind=drone,
 *                             0 / ignored otherwise. Drives drone silhouette + colour on the
 *                             client renderer. Kinds may only be APPENDED to the catalogue —
 *                             reordering invalidates this index for in-flight packets.)
 *
 * Sleeping entities ship one packet on the sleep-transition tick (recordFlags
 * bit 0 set, vx/vy = 0, angvel = 0), then drop out entirely until they wake.
 *
 * **Version contract**: a decoder that sees `version !== SWARM_WIRE_VERSION`
 * MUST drop the packet (and ideally surface a "please refresh" banner). Older
 * clients reading v3 with the v2 stride mis-attribute every byte after the
 * first record — never silently fall back. v2 had a 29-byte record without
 * the embedded angvel field; v1 had 28 bytes without shipKind.
 */

export const SWARM_WIRE_VERSION = 3;

export const SWARM_HEADER_BYTES = 8;
export const SWARM_RECORD_BYTES = 33;
/** Offset of the angvel f32 within a record (v3). */
export const SWARM_REC_ANGVEL_OFF = 24;
/** Offset of the radius f32 within a record (v3 — shifted from v2's +24). */
export const SWARM_REC_RADIUS_OFF = 28;
/** Offset of the `shipKind` byte within a record (v3 — shifted from v2's +28). Index into `SHIP_KINDS_LIST`. */
export const SWARM_REC_SHIP_KIND_OFF = 32;

export const SWARM_FLAG_FULL = 1 << 0;
export const SWARM_FLAG_DECIMATED = 1 << 1;

export const SWARM_RECORD_FLAG_SLEEPING = 1 << 0;
/** Phase: shield — set while a drone's shield is at 0 (hull exposed).
 *  Spare bit in the existing recordFlags byte: NO stride change, NO
 *  SWARM_WIRE_VERSION bump. */
export const SWARM_RECORD_FLAG_SHIELD_DOWN = 1 << 1;

export const SWARM_KIND_ASTEROID = 0;
export const SWARM_KIND_DRONE = 1;

/** Maximum number of records that fit in a buffer of `bufBytes` total bytes. */
export function swarmRecordCapacity(bufBytes: number): number {
  return Math.floor((bufBytes - SWARM_HEADER_BYTES) / SWARM_RECORD_BYTES);
}

/** Byte size for `count` records plus the header. */
export function swarmPacketSize(count: number): number {
  return SWARM_HEADER_BYTES + count * SWARM_RECORD_BYTES;
}
