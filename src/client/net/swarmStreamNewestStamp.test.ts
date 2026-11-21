/**
 * S4-2 (netcode gap smoothing, wave 5): the decoder records, per tick-stamped
 * swarm packet, the newest sample stamp for the drone stream as a whole
 * (`getSwarmStreamNewestStampMs`, in `swarmArrivalStampMs` units). Nothing
 * reads it yet; S4-4/S4-5 use it to tell "the stream stalled" from "this one
 * drone was not in the packet".
 *
 * Rule: the packet with the newer server tick wins. A reordered or late packet
 * (equal or older tick) leaves the value alone, so it never goes backwards on
 * one. Keyed on the tick rather than a plain max of stamps so a re-seeded tick
 * clock (a new timeline) is followed instead of hidden behind a stale value.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { decodeSwarmPacket } from './BinarySwarmDecoder.js';
import {
  getSwarmStreamNewestStampMs,
  noteSwarmStreamStamp,
  resetSwarmDisplayDelay,
  resetSwarmTickClock,
  swarmArrivalStampMs,
} from './swarmInterpolation.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';
import {
  SWARM_HEADER_BYTES, SWARM_RECORD_BYTES, SWARM_REC_RADIUS_OFF, SWARM_FLAG_FULL, SWARM_WIRE_VERSION,
} from '../../shared-types/swarmWireFormat.js';

/** Wall ms per server tick at 1× (the room steps at 60 Hz). */
const TICK_MS = 1000 / 60;

/** One-drone packet built from the published byte layout (no server import). */
function packet(tick: number, ids: readonly number[], x = 0): Uint8Array {
  const buf = new ArrayBuffer(SWARM_HEADER_BYTES + ids.length * SWARM_RECORD_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, SWARM_WIRE_VERSION);
  view.setUint8(1, SWARM_FLAG_FULL);
  view.setUint16(2, ids.length, true);
  view.setUint32(4, tick, true);
  let off = SWARM_HEADER_BYTES;
  for (const id of ids) {
    view.setUint16(off, id, true);
    view.setFloat32(off + 4, x, true);
    view.setFloat32(off + SWARM_REC_RADIUS_OFF, 10, true);
    off += SWARM_RECORD_BYTES;
  }
  return new Uint8Array(buf);
}

function makeMirror(): RenderMirror {
  return { ships: new Map(), localPlayerId: null };
}

beforeEach(() => {
  resetSwarmTickClock();
});

describe('swarm stream newest stamp (S4-2)', () => {
  it('is NaN until the first tick-stamped packet', () => {
    expect(getSwarmStreamNewestStampMs()).toBeNaN();
    // A packet decoded without tick stamps (tests / legacy path) does not set it.
    decodeSwarmPacket(packet(10, [1]), makeMirror(), 1000);
    expect(getSwarmStreamNewestStampMs()).toBeNaN();
  });

  it('follows the newest stamp per packet, equal to the ring stamp', () => {
    const mirror = makeMirror();
    for (let i = 0; i < 20; i++) {
      const tick = 100 + i;
      decodeSwarmPacket(packet(tick, [1]), mirror, 5000 + i * TICK_MS, true);
      const ring = mirror.swarm!.get(1)!.poseRing;
      const head = mirror.swarm!.get(1)!.ringHead;
      const newestSlot = ring[(head - 1 + ring.length) % ring.length]!;
      expect(getSwarmStreamNewestStampMs()).toBe(newestSlot.arrivalMs);
    }
  });

  it('tracks the stream, not one drone: a packet without the drone still advances it', () => {
    const mirror = makeMirror();
    decodeSwarmPacket(packet(100, [1, 2]), mirror, 5000, true);
    const droneOneStamp = mirror.swarm!.get(1)!.poseRing[0]!.arrivalMs;
    decodeSwarmPacket(packet(101, [2]), mirror, 5000 + TICK_MS, true);
    expect(getSwarmStreamNewestStampMs()).toBeGreaterThan(droneOneStamp);
  });

  it('never goes backwards on a reordered or late packet', () => {
    const mirror = makeMirror();
    decodeSwarmPacket(packet(100, [1]), mirror, 5000, true);
    decodeSwarmPacket(packet(102, [1]), mirror, 5000 + 2 * TICK_MS, true);
    const newest = getSwarmStreamNewestStampMs();
    // Tick 101 arrives after 102 (reordered), then 102 again much later (late dup).
    decodeSwarmPacket(packet(101, [1]), mirror, 5000 + 3 * TICK_MS, true);
    expect(getSwarmStreamNewestStampMs()).toBe(newest);
    decodeSwarmPacket(packet(102, [1]), mirror, 5000 + 30 * TICK_MS, true);
    expect(getSwarmStreamNewestStampMs()).toBe(newest);
    // The next newer tick moves it on.
    decodeSwarmPacket(packet(103, [1]), mirror, 5000 + 31 * TICK_MS, true);
    expect(getSwarmStreamNewestStampMs()).toBeGreaterThan(newest);
  });

  it('setter: an older or equal tick is ignored even with a later stamp', () => {
    noteSwarmStreamStamp(50, 900);
    noteSwarmStreamStamp(49, 2000);
    noteSwarmStreamStamp(50, 2000);
    expect(getSwarmStreamNewestStampMs()).toBe(900);
    noteSwarmStreamStamp(51, 916);
    expect(getSwarmStreamNewestStampMs()).toBe(916);
  });

  it('is cleared by the reset path resetPredictionState calls (resetSwarmDisplayDelay)', () => {
    decodeSwarmPacket(packet(500, [1]), makeMirror(), 8000, true);
    expect(getSwarmStreamNewestStampMs()).not.toBeNaN();
    resetSwarmDisplayDelay();
    expect(getSwarmStreamNewestStampMs()).toBeNaN();
    // A new room restarts its tick count low: after the reset it is taken at once.
    decodeSwarmPacket(packet(3, [1]), makeMirror(), 9000, true);
    expect(getSwarmStreamNewestStampMs()).toBe(9000);
  });

  it('decoding allocates nothing new: entry, ring and slots are reused, the value is a scalar', () => {
    const mirror = makeMirror();
    decodeSwarmPacket(packet(100, [1]), mirror, 5000, true);
    const entry = mirror.swarm!.get(1)!;
    const ring = entry.poseRing;
    const slots = ring.slice();
    for (let i = 1; i < 200; i++) {
      decodeSwarmPacket(packet(100 + i, [1], i), mirror, 5000 + i * TICK_MS, true);
    }
    expect(mirror.swarm!.get(1)).toBe(entry);
    expect(entry.poseRing).toBe(ring);
    for (let s = 0; s < slots.length; s++) expect(ring[s]).toBe(slots[s]);
    expect(typeof getSwarmStreamNewestStampMs()).toBe('number');
    // The stamp the decoder recorded is the one the tick clock gives that tick.
    resetSwarmTickClock();
    const expected = swarmArrivalStampMs(7, 100);
    resetSwarmTickClock();
    decodeSwarmPacket(packet(7, [1]), makeMirror(), 100, true);
    expect(getSwarmStreamNewestStampMs()).toBe(expected);
  });
});
