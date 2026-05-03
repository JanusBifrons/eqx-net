/**
 * Zero-allocation decoder for the binary swarm packet.
 *
 * On each call, mutates `mirror.swarm` in place: updates poses for entities
 * in the packet and (because the encoder ships every full snapshot at the
 * 60-tick cadence) reconciles "stale" entries by clearing them only when a
 * full-snapshot packet arrives that omits them.
 *
 * Sleeping entities arrive once on the sleep-transition tick with bit 0 set
 * and then drop out until they wake. The decoder marks `sleeping=true` so
 * the renderer freezes interpolation; the entry stays in the mirror.
 */
import type { RenderMirror, SwarmRenderState } from '../../core/contracts/IRenderer.js';
import {
  SWARM_HEADER_BYTES, SWARM_RECORD_BYTES,
  SWARM_FLAG_FULL,
  SWARM_RECORD_FLAG_SLEEPING,
  SWARM_WIRE_VERSION,
} from '../../shared-types/swarmWireFormat.js';

interface MutableMirror {
  swarm?: Map<number, SwarmRenderState>;
}

/**
 * Decode a swarm packet into `mirror.swarm`. Accepts `ArrayBuffer`,
 * `ArrayBufferView`, or a `Uint8Array` because `client.send('swarm', buf)`
 * may deliver any of these shapes through ws.
 *
 * Reuses entry objects in-place to avoid per-tick allocation.
 */
export function decodeSwarmPacket(input: ArrayBuffer | ArrayBufferView, mirror: RenderMirror): void {
  // Build a DataView that reads the live bytes regardless of whether the
  // input is a raw ArrayBuffer, a Uint8Array view, or a SharedArrayBuffer-
  // backed view (some ws transports deliver the latter). No copy.
  let view: DataView;
  let byteLength: number;
  if (input instanceof ArrayBuffer) {
    view = new DataView(input);
    byteLength = input.byteLength;
  } else {
    const ab = input.buffer as ArrayBuffer;
    view = new DataView(ab, input.byteOffset, input.byteLength);
    byteLength = input.byteLength;
  }

  if (byteLength < SWARM_HEADER_BYTES) return;

  const version = view.getUint8(0);
  if (version !== SWARM_WIRE_VERSION) return;
  const flags = view.getUint8(1);
  const count = view.getUint16(2, true);
  const tick = view.getUint32(4, true);

  const expectedBytes = SWARM_HEADER_BYTES + count * SWARM_RECORD_BYTES;
  if (byteLength < expectedBytes) return;

  // Lazily initialise the swarm map on the mirror.
  const m = mirror as RenderMirror & MutableMirror;
  if (!m.swarm) m.swarm = new Map();
  const swarm = m.swarm;

  const isFull = (flags & SWARM_FLAG_FULL) !== 0;
  // For full snapshots, gather the set of entityIds present so we can drop
  // ones the server no longer knows about.
  const seen = isFull ? new Set<number>() : null;

  let off = SWARM_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const entityId = view.getUint16(off + 0, true);
    const kind = view.getUint8(off + 2);
    const recFlags = view.getUint8(off + 3);
    const x = view.getFloat32(off + 4, true);
    const y = view.getFloat32(off + 8, true);
    const vx = view.getFloat32(off + 12, true);
    const vy = view.getFloat32(off + 16, true);
    const angle = view.getFloat32(off + 20, true);
    const radius = view.getFloat32(off + 24, true);
    off += SWARM_RECORD_BYTES;

    const sleeping = (recFlags & SWARM_RECORD_FLAG_SLEEPING) !== 0;

    let entry = swarm.get(entityId);
    if (!entry) {
      entry = { x, y, vx, vy, angle, radius, kind, sleeping, lastUpdateTick: tick };
      swarm.set(entityId, entry);
    } else {
      entry.x = x;
      entry.y = y;
      entry.vx = vx;
      entry.vy = vy;
      entry.angle = angle;
      entry.radius = radius;
      entry.kind = kind;
      entry.sleeping = sleeping;
      entry.lastUpdateTick = tick;
    }

    if (seen) seen.add(entityId);
  }

  if (seen !== null) {
    // Full snapshot — entities not present anymore should be removed.
    for (const id of swarm.keys()) {
      if (!seen.has(id)) swarm.delete(id);
    }
  }
}
