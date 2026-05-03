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
 * Per-entity record (28 bytes):
 *   [+0]  u16  entityId      (dense 0..65535)
 *   [+2]  u8   kind          (0=asteroid, 1=drone)
 *   [+3]  u8   recordFlags   (bit 0 = SLEEPING)
 *   [+4]  f32  x
 *   [+8]  f32  y
 *   [+12] f32  vx
 *   [+16] f32  vy
 *   [+20] f32  angle
 *   [+24] f32  radius        (collision radius — needed by client renderer + server hitscan)
 *
 * Sleeping entities ship one packet on the sleep-transition tick (recordFlags
 * bit 0 set, vx/vy = 0), then drop out entirely until they wake.
 */

export const SWARM_WIRE_VERSION = 1;

export const SWARM_HEADER_BYTES = 8;
export const SWARM_RECORD_BYTES = 28;

export const SWARM_FLAG_FULL = 1 << 0;
export const SWARM_FLAG_DECIMATED = 1 << 1;

export const SWARM_RECORD_FLAG_SLEEPING = 1 << 0;

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
