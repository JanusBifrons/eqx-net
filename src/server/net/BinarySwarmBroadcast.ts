/**
 * Binary swarm broadcast — encodes the swarm subset of SAB into a fixed-stride
 * binary packet and ships it via `client.send('swarm', buf)`. Bypasses
 * Colyseus MapSchema entirely so 500-entity broadcasts don't pay the schema
 * patch cost.
 *
 * Phase 5c is broadcast-all (every entity to every client every tick or as a
 * delta). The Interest Grid in 5d narrows that to a per-client subset.
 *
 * Source of truth for poses is the SAB written by the physics worker. The
 * registry only stores per-record metadata (id, kind, last-broadcast pose,
 * sleeping bit) — never the live position.
 */
import {
  SLOT_X_OFF, SLOT_Y_OFF, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_ANGLE_OFF, SLOT_FLAGS_OFF,
  FLAG_SLEEPING, slotBase, MAX_ENTITIES,
} from '../../shared-types/sabLayout.js';
import {
  SWARM_HEADER_BYTES, SWARM_RECORD_BYTES,
  SWARM_FLAG_FULL,
  SWARM_RECORD_FLAG_SLEEPING,
  SWARM_WIRE_VERSION,
  swarmPacketSize,
} from '../../shared-types/swarmWireFormat.js';
import { SwarmEntityRegistry, type SwarmEntityRecord } from './SwarmEntityRegistry.js';

/** Tick cadence at which a full snapshot is forced regardless of changes. */
const FULL_SNAPSHOT_INTERVAL_TICKS = 60;

/**
 * Pre-allocated single packet buffer, sized for the worst case of every
 * registered entity in one packet. 24 bytes/record × 1024 + 8-byte header
 * fits in one buffer; the encoder reuses it every tick.
 */
export class BinarySwarmBroadcast {
  private readonly buf: ArrayBuffer;
  private readonly view: DataView;
  private readonly bufU8: Uint8Array;

  constructor() {
    const cap = swarmPacketSize(MAX_ENTITIES);
    this.buf = new ArrayBuffer(cap);
    this.view = new DataView(this.buf);
    this.bufU8 = new Uint8Array(this.buf);
  }

  /**
   * Encode a packet for the given registry. Returns a `Uint8Array` view onto
   * the internal buffer truncated to the packet's actual size, or `null` if
   * there's nothing worth shipping this tick.
   *
   * Mutates each shipped record's `lastBroadcast` / `lastBroadcastSleeping` /
   * `lastBroadcastTick` so subsequent calls produce correct deltas.
   */
  encode(
    registry: SwarmEntityRegistry,
    sabF32: Float32Array,
    sabU32: Uint32Array,
    serverTick: number,
  ): Uint8Array | null {
    if (registry.size() === 0) return null;

    const isFullSnapshot = serverTick % FULL_SNAPSHOT_INTERVAL_TICKS === 0;
    let count = 0;
    let writeOffset = SWARM_HEADER_BYTES;

    for (const rec of registry.all()) {
      const base = slotBase(rec.slot);
      const x = sabF32[base + SLOT_X_OFF]!;
      const y = sabF32[base + SLOT_Y_OFF]!;
      const angle = sabF32[base + SLOT_ANGLE_OFF]!;
      const flagsWord = sabU32[base + SLOT_FLAGS_OFF]!;
      const sleeping = (flagsWord & FLAG_SLEEPING) !== 0;

      const sleepChanged = sleeping !== rec.lastBroadcastSleeping;
      const poseChanged = SwarmEntityRegistry.poseChanged(rec, x, y, angle);

      // Sleeping entities drop out entirely on subsequent ticks unless they
      // wake. The transition tick (sleeping became true) still ships once so
      // the client can freeze interpolation at the final pose.
      let include = false;
      if (isFullSnapshot) {
        include = true;
      } else if (sleepChanged) {
        include = true;
      } else if (sleeping) {
        include = false; // already shipped on transition; stay quiet
      } else {
        include = poseChanged;
      }

      if (!include) continue;

      const vx = sabF32[base + SLOT_VX_OFF]!;
      const vy = sabF32[base + SLOT_VY_OFF]!;

      // Per-record header.
      this.view.setUint16(writeOffset + 0, rec.entityId, true);
      this.view.setUint8(writeOffset + 2, rec.kind);
      const recFlags = sleeping ? SWARM_RECORD_FLAG_SLEEPING : 0;
      this.view.setUint8(writeOffset + 3, recFlags);
      this.view.setFloat32(writeOffset + 4, x, true);
      this.view.setFloat32(writeOffset + 8, y, true);
      this.view.setFloat32(writeOffset + 12, sleeping ? 0 : vx, true);
      this.view.setFloat32(writeOffset + 16, sleeping ? 0 : vy, true);
      this.view.setFloat32(writeOffset + 20, angle, true);
      this.view.setFloat32(writeOffset + 24, rec.radius, true);
      writeOffset += SWARM_RECORD_BYTES;

      // Update bookkeeping so future deltas are computed against this pose.
      rec.lastBroadcast.x = x;
      rec.lastBroadcast.y = y;
      rec.lastBroadcast.angle = angle;
      rec.lastBroadcastSleeping = sleeping;
      rec.lastBroadcastTick = serverTick;
      count++;
    }

    if (count === 0) return null;

    // Header.
    this.view.setUint8(0, SWARM_WIRE_VERSION);
    this.view.setUint8(1, isFullSnapshot ? SWARM_FLAG_FULL : 0);
    this.view.setUint16(2, count, true);
    this.view.setUint32(4, serverTick >>> 0, true);

    return this.bufU8.subarray(0, writeOffset);
  }
}

export type SwarmEncoder = BinarySwarmBroadcast;
export type { SwarmEntityRecord };
