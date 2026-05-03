import { describe, it, expect, beforeEach } from 'vitest';
import { BinarySwarmBroadcast } from './BinarySwarmBroadcast.js';
import { SwarmEntityRegistry } from './SwarmEntityRegistry.js';
import {
  SAB_TOTAL_BYTES,
  slotBase,
  SLOT_X_OFF, SLOT_Y_OFF, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_ANGLE_OFF, SLOT_FLAGS_OFF,
  FLAG_SLEEPING,
} from '../../shared-types/sabLayout.js';
import {
  SWARM_HEADER_BYTES, SWARM_RECORD_BYTES,
  SWARM_FLAG_FULL, SWARM_RECORD_FLAG_SLEEPING,
  SWARM_WIRE_VERSION,
} from '../../shared-types/swarmWireFormat.js';

const SLOT_A = 5;
const SLOT_B = 7;

function makeSab(): { f32: Float32Array; u32: Uint32Array } {
  const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
  return { f32: new Float32Array(sab), u32: new Uint32Array(sab) };
}

function setSlotPose(f32: Float32Array, slot: number, x: number, y: number, vx: number, vy: number, angle: number): void {
  const b = slotBase(slot);
  f32[b + SLOT_X_OFF] = x;
  f32[b + SLOT_Y_OFF] = y;
  f32[b + SLOT_VX_OFF] = vx;
  f32[b + SLOT_VY_OFF] = vy;
  f32[b + SLOT_ANGLE_OFF] = angle;
}

function setSlotSleeping(u32: Uint32Array, slot: number, sleeping: boolean): void {
  const b = slotBase(slot);
  const prev = u32[b + SLOT_FLAGS_OFF] ?? 0;
  u32[b + SLOT_FLAGS_OFF] = sleeping ? prev | FLAG_SLEEPING : prev & ~FLAG_SLEEPING;
}

describe('BinarySwarmBroadcast — encoder', () => {
  let registry: SwarmEntityRegistry;
  let encoder: BinarySwarmBroadcast;
  let f32: Float32Array;
  let u32: Uint32Array;

  beforeEach(() => {
    registry = new SwarmEntityRegistry();
    encoder = new BinarySwarmBroadcast();
    ({ f32, u32 } = makeSab());
  });

  it('returns null when registry is empty', () => {
    const packet = encoder.encode(registry, f32, u32, 1);
    expect(packet).toBeNull();
  });

  it('full snapshot at tick=0 (every-60th-tick rule) ships every entity', () => {
    registry.register('asteroid-0', SLOT_A, 0, 32, 100, 200, 0);
    setSlotPose(f32, SLOT_A, 100, 200, 0, 0, 0);

    // tick=60 is a full snapshot tick (60 % 60 === 0).
    const packet = encoder.encode(registry, f32, u32, 60);
    expect(packet).not.toBeNull();

    const view = new DataView(packet!.buffer, packet!.byteOffset, packet!.byteLength);
    expect(view.getUint8(0)).toBe(SWARM_WIRE_VERSION);
    expect(view.getUint8(1) & SWARM_FLAG_FULL).toBe(SWARM_FLAG_FULL);
    expect(view.getUint16(2, true)).toBe(1);
    expect(view.getUint32(4, true)).toBe(60);

    expect(view.getUint16(SWARM_HEADER_BYTES + 0, true)).toBe(0); // first entityId
    expect(view.getUint8(SWARM_HEADER_BYTES + 2)).toBe(0);        // kind=asteroid
    expect(view.getFloat32(SWARM_HEADER_BYTES + 4, true)).toBeCloseTo(100, 5);
    expect(view.getFloat32(SWARM_HEADER_BYTES + 8, true)).toBeCloseTo(200, 5);
    expect(view.getFloat32(SWARM_HEADER_BYTES + 24, true)).toBeCloseTo(32, 5);
  });

  it('delta packet skips entities whose pose has not moved past the quantisation epsilon', () => {
    registry.register('asteroid-0', SLOT_A, 0, 32, 0, 0, 0);
    registry.register('asteroid-1', SLOT_B, 0, 24, 0, 0, 0);
    setSlotPose(f32, SLOT_A, 100, 0, 0, 0, 0);
    setSlotPose(f32, SLOT_B, 0, 100, 0, 0, 0);

    // Tick 60 — full snapshot, both entities ship.
    let packet = encoder.encode(registry, f32, u32, 60);
    expect(packet).not.toBeNull();
    expect(new DataView(packet!.buffer, packet!.byteOffset).getUint16(2, true)).toBe(2);

    // Tick 61 — delta. No movement — encoder should return null.
    packet = encoder.encode(registry, f32, u32, 61);
    expect(packet).toBeNull();

    // Move asteroid-0 by 0.06u (above the 0.05u threshold).
    setSlotPose(f32, SLOT_A, 100.06, 0, 0, 0, 0);
    packet = encoder.encode(registry, f32, u32, 62);
    expect(packet).not.toBeNull();
    expect(new DataView(packet!.buffer, packet!.byteOffset).getUint16(2, true)).toBe(1);
  });

  it('sleeping flag transition ships once, then drops out', () => {
    registry.register('rock', SLOT_A, 0, 32, 0, 0, 0);
    setSlotPose(f32, SLOT_A, 0, 0, 0, 0, 0);

    // Bootstrap with a full snapshot.
    encoder.encode(registry, f32, u32, 60);

    // No movement, no sleep change → null.
    let packet = encoder.encode(registry, f32, u32, 61);
    expect(packet).toBeNull();

    // Sleep transition → ship once with the SLEEPING bit.
    setSlotSleeping(u32, SLOT_A, true);
    packet = encoder.encode(registry, f32, u32, 62);
    expect(packet).not.toBeNull();
    const v = new DataView(packet!.buffer, packet!.byteOffset);
    expect(v.getUint16(2, true)).toBe(1);
    expect(v.getUint8(SWARM_HEADER_BYTES + 3) & SWARM_RECORD_FLAG_SLEEPING).toBe(SWARM_RECORD_FLAG_SLEEPING);

    // Subsequent ticks with no change → null (entity stays quiet while sleeping).
    expect(encoder.encode(registry, f32, u32, 63)).toBeNull();
    expect(encoder.encode(registry, f32, u32, 64)).toBeNull();
  });

  it('wake transition ships a fresh non-sleeping packet', () => {
    registry.register('rock', SLOT_A, 0, 32, 0, 0, 0);
    setSlotPose(f32, SLOT_A, 0, 0, 0, 0, 0);
    setSlotSleeping(u32, SLOT_A, true);
    encoder.encode(registry, f32, u32, 60); // full snapshot, sleeping=true
    expect(encoder.encode(registry, f32, u32, 61)).toBeNull();

    // Wake.
    setSlotSleeping(u32, SLOT_A, false);
    setSlotPose(f32, SLOT_A, 5, 0, 0.5, 0, 0);
    const packet = encoder.encode(registry, f32, u32, 62);
    expect(packet).not.toBeNull();
    const v = new DataView(packet!.buffer, packet!.byteOffset);
    expect(v.getUint8(SWARM_HEADER_BYTES + 3) & SWARM_RECORD_FLAG_SLEEPING).toBe(0);
  });

  it('sleeping packet zeros vx/vy on the wire even if SAB still has nonzero residual', () => {
    registry.register('rock', SLOT_A, 0, 32, 0, 0, 0);
    setSlotPose(f32, SLOT_A, 0, 0, 0.3, -0.1, 0);
    setSlotSleeping(u32, SLOT_A, true);
    const packet = encoder.encode(registry, f32, u32, 60);
    expect(packet).not.toBeNull();
    const v = new DataView(packet!.buffer, packet!.byteOffset);
    expect(v.getFloat32(SWARM_HEADER_BYTES + 12, true)).toBe(0); // vx
    expect(v.getFloat32(SWARM_HEADER_BYTES + 16, true)).toBe(0); // vy
  });

  it('packet byte length is HEADER + count * RECORD', () => {
    registry.register('a', SLOT_A, 0, 32, 0, 0, 0);
    registry.register('b', SLOT_B, 1, 14, 0, 0, 0);
    setSlotPose(f32, SLOT_A, 1, 0, 0, 0, 0);
    setSlotPose(f32, SLOT_B, 0, 1, 0, 0, 0);
    const packet = encoder.encode(registry, f32, u32, 60);
    expect(packet).not.toBeNull();
    expect(packet!.byteLength).toBe(SWARM_HEADER_BYTES + 2 * SWARM_RECORD_BYTES);
  });
});
