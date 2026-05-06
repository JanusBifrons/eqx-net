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
  SWARM_REC_SHIP_KIND_OFF,
  SWARM_FLAG_FULL,
  SWARM_RECORD_FLAG_SLEEPING,
  SWARM_WIRE_VERSION,
  swarmPacketSize,
} from '../../shared-types/swarmWireFormat.js';
import { shipKindToIndex, isShipKindId } from '../../shared-types/shipKinds.js';
import { SwarmEntityRegistry, type SwarmEntityRecord } from './SwarmEntityRegistry.js';

/** Tick cadence at which a full snapshot is forced regardless of changes. */
const FULL_SNAPSHOT_INTERVAL_TICKS = 60;

/**
 * How often out-of-interest entities still get shipped to a given client. At
 * 60 Hz this is once every 100 ms, plenty for a sprite living at the edge of
 * vision that the client is barely looking at.
 */
const DECIMATION_TICKS = 6;

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
   * Encode a packet for the given registry, optionally filtered by per-client
   * interest. Returns a `Uint8Array` view onto the internal buffer truncated
   * to the packet's actual size, or `null` if there's nothing worth shipping
   * this tick.
   *
   * Phase 5d adds the `inInterest` parameter — a set of dense u16 entity ids
   * the client wants at full fidelity (the 9-cell window from `SpatialGrid`).
   * Out-of-interest entities are still shipped every `DECIMATION_TICKS` so
   * the client has a stale-but-present pose if the local ship suddenly moves
   * toward them. Pass `undefined` to disable filtering (broadcast-all, the
   * Phase 5c path before the grid was wired).
   *
   * **Important**: when filtering is enabled, the encoder no longer mutates
   * `rec.lastBroadcast*` from a single shared encode pass — different clients
   * see different last-broadcast frames depending on their interest window.
   * The bookkeeping is therefore *only* updated based on what was actually
   * shipped to *this* client. To keep delta detection conservative and
   * correct, the per-client encoder writes are based on a passed-in
   * "lastBroadcast" snapshot that tracks per-(client, entity) state. For now
   * (Phase 5d) we keep the registry-level last-broadcast as a lower-bound
   * heuristic shared across clients — entities are slightly more likely to
   * be re-shipped on a delta than strictly necessary, but it's safe.
   *
   * Mutates each shipped record's `lastBroadcast` / `lastBroadcastSleeping` /
   * `lastBroadcastTick` so subsequent calls produce correct deltas.
   */
  encode(
    registry: SwarmEntityRegistry,
    sabF32: Float32Array,
    sabU32: Uint32Array,
    serverTick: number,
    inInterest?: Set<number>,
  ): Uint8Array | null {
    if (registry.size() === 0) return null;

    const isFullSnapshot = serverTick % FULL_SNAPSHOT_INTERVAL_TICKS === 0;
    const decimationTickThisFrame = serverTick % DECIMATION_TICKS === 0;
    let count = 0;
    let writeOffset = SWARM_HEADER_BYTES;

    for (const rec of registry.all()) {
      const base = slotBase(rec.slot);
      const x = sabF32[base + SLOT_X_OFF]!;
      const y = sabF32[base + SLOT_Y_OFF]!;
      const angle = sabF32[base + SLOT_ANGLE_OFF]!;
      const flagsWord = sabU32[base + SLOT_FLAGS_OFF]!;
      const sleeping = (flagsWord & FLAG_SLEEPING) !== 0;

      const vx = sabF32[base + SLOT_VX_OFF]!;
      const vy = sabF32[base + SLOT_VY_OFF]!;

      const sleepChanged = sleeping !== rec.lastBroadcastSleeping;
      const poseChanged = SwarmEntityRegistry.poseChanged(rec, x, y, angle, vx, vy);

      // Phase 5d interest filtering. Entities outside the per-client window
      // still ship at decimated cadence so the client has a recent-enough
      // pose if its window suddenly shifts (e.g. fast travel, teleport).
      const inInterestForThisClient = !inInterest || inInterest.has(rec.entityId);
      const decimatedShip = !inInterestForThisClient && decimationTickThisFrame;

      // Sleeping entities drop out entirely on subsequent ticks unless they
      // wake. The transition tick (sleeping became true) still ships once so
      // the client can freeze interpolation at the final pose.
      //
      // Decimated ships are UNCONDITIONAL on the decimation tick (not gated
      // by poseChanged). Reason: rec.lastBroadcast is shared across all
      // clients, so an entity that just shipped to client A would look
      // "unchanged" to the encoder when it gets to client B — but B may have
      // never seen any pose for that entity at all if it's been out of
      // interest. Shipping unconditionally bounds wire cost trivially
      // (entities × clients × 24 B / DECIMATION_TICKS) and removes a class
      // of subtle "stale pose" bugs around interest-window crossings.
      let include = false;
      if (isFullSnapshot) {
        include = true;
      } else if (sleepChanged) {
        include = true;
      } else if (sleeping) {
        include = false; // already shipped on transition; stay quiet
      } else if (inInterestForThisClient) {
        include = poseChanged;
      } else if (decimatedShip) {
        include = true;
      } else {
        include = false;
      }

      if (!include) continue;

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
      // v2 trailing byte: drone's ship-kind index. Asteroids write 0 (the
      // client decoder ignores the byte for kind=0 records anyway).
      const shipKindIdx = rec.kind === 1 && rec.shipKind && isShipKindId(rec.shipKind)
        ? shipKindToIndex(rec.shipKind)
        : 0;
      this.view.setUint8(writeOffset + SWARM_REC_SHIP_KIND_OFF, shipKindIdx);
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
