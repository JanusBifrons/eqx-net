import { describe, it, expect, beforeEach } from 'vitest';
import { BinarySwarmBroadcast } from './BinarySwarmBroadcast.js';
import { SwarmEntityRegistry } from './SwarmEntityRegistry.js';
import {
  SAB_TOTAL_BYTES,
  slotBase,
  SLOT_X_OFF, SLOT_Y_OFF, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_ANGLE_OFF, SLOT_ANGVEL_OFF, SLOT_FLAGS_OFF,
  FLAG_SLEEPING,
} from '../../shared-types/sabLayout.js';
import {
  SWARM_HEADER_BYTES, SWARM_RECORD_BYTES,
  SWARM_REC_ANGVEL_OFF,
  SWARM_REC_RADIUS_OFF,
  SWARM_REC_SHIP_KIND_OFF,
  SWARM_REC_COMPONENT_INDEX_OFF,
  SWARM_FLAG_FULL, SWARM_RECORD_FLAG_SLEEPING,
  SWARM_WIRE_VERSION,
  SWARM_KIND_STRUCTURE,
  SWARM_KIND_SCRAP,
} from '../../shared-types/swarmWireFormat.js';
import { structureKindToIndex } from '../../shared-types/structureKinds.js';
import { shipKindToIndex } from '../../shared-types/shipKinds.js';

const SLOT_A = 5;
const SLOT_B = 7;

function makeSab(): { f32: Float32Array; u32: Uint32Array } {
  const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
  return { f32: new Float32Array(sab), u32: new Uint32Array(sab) };
}

function setSlotPose(f32: Float32Array, slot: number, x: number, y: number, vx: number, vy: number, angle: number, angvel: number = 0): void {
  const b = slotBase(slot);
  f32[b + SLOT_X_OFF] = x;
  f32[b + SLOT_Y_OFF] = y;
  f32[b + SLOT_VX_OFF] = vx;
  f32[b + SLOT_VY_OFF] = vy;
  f32[b + SLOT_ANGLE_OFF] = angle;
  f32[b + SLOT_ANGVEL_OFF] = angvel;
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
    // v3: radius lives at +28 (was +24 in v2 — moved to make room for angvel).
    expect(view.getFloat32(SWARM_HEADER_BYTES + SWARM_REC_RADIUS_OFF, true)).toBeCloseTo(32, 5);
  });

  // Phase A — wire-format v3 (2026-05-09 AI lockstep).
  it('ships angvel from SAB at the v3 record offset', () => {
    registry.register('drone', SLOT_A, 1, 14, 0, 0, 0);
    setSlotPose(f32, SLOT_A, 0, 0, 0.6, 0, 0.5, 1.25); // taxicab speed > 0.5 forces ship
    const packet = encoder.encode(registry, f32, u32, 60);
    expect(packet).not.toBeNull();
    const view = new DataView(packet!.buffer, packet!.byteOffset, packet!.byteLength);
    expect(view.getFloat32(SWARM_HEADER_BYTES + SWARM_REC_ANGVEL_OFF, true)).toBeCloseTo(1.25, 5);
  });

  it('sleeping packet zeros angvel on the wire even if SAB still has nonzero residual', () => {
    registry.register('drone', SLOT_A, 1, 14, 0, 0, 0);
    setSlotPose(f32, SLOT_A, 0, 0, 0, 0, 0, 0.7);
    setSlotSleeping(u32, SLOT_A, true);
    const packet = encoder.encode(registry, f32, u32, 60);
    expect(packet).not.toBeNull();
    const view = new DataView(packet!.buffer, packet!.byteOffset, packet!.byteLength);
    expect(view.getFloat32(SWARM_HEADER_BYTES + SWARM_REC_ANGVEL_OFF, true)).toBe(0);
  });

  it('angvel-only change above quantisation triggers a delta ship', () => {
    registry.register('drone', SLOT_A, 1, 14, 0, 0, 0);
    // Stationary, angle steady, but spinning. Bootstrap full snapshot with 0
    // angvel; subsequent tick the SAB angvel jumps to 0.2 (above the 0.05
    // QUANT_ANGVEL threshold).
    setSlotPose(f32, SLOT_A, 0, 0, 0, 0, 0, 0);
    encoder.encode(registry, f32, u32, 60);
    expect(encoder.encode(registry, f32, u32, 61)).toBeNull();

    setSlotPose(f32, SLOT_A, 0, 0, 0, 0, 0, 0.2);
    const packet = encoder.encode(registry, f32, u32, 62);
    expect(packet).not.toBeNull();
    expect(new DataView(packet!.buffer, packet!.byteOffset).getUint16(2, true)).toBe(1);
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

  // Defect 2 (5c-stabilise plan): velocity-aware suppression. Stationary entities
  // are gated by quantisation thresholds; moving entities ship every tick.

  it('moving entity (|vx|+|vy| > 0.5) ships every tick even with sub-quantum delta', () => {
    registry.register('drone-fast', SLOT_A, 1, 14, 0, 0, 0);
    setSlotPose(f32, SLOT_A, 0, 0, 0.6, 0, 0); // taxicab speed 0.6 > 0.5

    // Bootstrap with a full snapshot.
    encoder.encode(registry, f32, u32, 60);

    // Advance pose by tiny amount that's BELOW quantisation epsilon (0.05u).
    setSlotPose(f32, SLOT_A, 0.01, 0, 0.6, 0, 0);
    const packet = encoder.encode(registry, f32, u32, 61);
    expect(packet).not.toBeNull();
    expect(new DataView(packet!.buffer, packet!.byteOffset).getUint16(2, true)).toBe(1);
  });

  it('stationary entity below quantisation is not shipped on delta ticks', () => {
    registry.register('rock', SLOT_A, 0, 32, 0, 0, 0);
    setSlotPose(f32, SLOT_A, 0, 0, 0, 0, 0);

    encoder.encode(registry, f32, u32, 60); // bootstrap

    // Tiny sub-quantum drift, no velocity.
    setSlotPose(f32, SLOT_A, 0.01, 0, 0, 0, 0);
    const packet = encoder.encode(registry, f32, u32, 61);
    expect(packet).toBeNull();
  });

  it('moving entity above quantisation still ships (no regression in fast path)', () => {
    registry.register('drone-fast', SLOT_A, 1, 14, 0, 0, 0);
    setSlotPose(f32, SLOT_A, 0, 0, 1.0, 0, 0);
    encoder.encode(registry, f32, u32, 60);
    // Above-quantum motion AND moving — two reasons to ship; we just confirm
    // the packet still goes out (i.e. the velocity gate didn't accidentally
    // mask normal motion).
    setSlotPose(f32, SLOT_A, 0.5, 0, 1.0, 0, 0);
    const packet = encoder.encode(registry, f32, u32, 61);
    expect(packet).not.toBeNull();
    expect(new DataView(packet!.buffer, packet!.byteOffset).getUint16(2, true)).toBe(1);
  });

  // Phase 5d: per-client interest filtering + 6-tick decimation.

  it('inInterest filter excludes out-of-interest entities on non-decimation ticks', () => {
    const inA = registry.register('a', SLOT_A, 0, 32, 0, 0, 0);
    const inB = registry.register('b', SLOT_B, 0, 32, 100, 0, 0);
    setSlotPose(f32, SLOT_A, 0, 0, 1.0, 0, 0);
    setSlotPose(f32, SLOT_B, 100, 0, 1.0, 0, 0);

    encoder.encode(registry, f32, u32, 60);

    // Tick 61 isn't a decimation tick (61 % 6 !== 0). Only "a" is in
    // interest — "b" should be omitted.
    setSlotPose(f32, SLOT_A, 1, 0, 1.0, 0, 0);
    setSlotPose(f32, SLOT_B, 101, 0, 1.0, 0, 0);
    const inInterest = new Set<number>([inA.entityId]);
    const packet = encoder.encode(registry, f32, u32, 61, inInterest);

    expect(packet).not.toBeNull();
    expect(new DataView(packet!.buffer, packet!.byteOffset).getUint16(2, true)).toBe(1);
    expect(inB).toBeDefined(); // suppress unused-var
  });

  it('decimation tick (every 6th tick) ships out-of-interest entities unconditionally', () => {
    const inA = registry.register('a', SLOT_A, 0, 32, 0, 0, 0);
    registry.register('b', SLOT_B, 0, 32, 100, 0, 0);
    setSlotPose(f32, SLOT_A, 0, 0, 1.0, 0, 0);
    setSlotPose(f32, SLOT_B, 100, 0, 0, 0, 0); // stationary out-of-interest

    encoder.encode(registry, f32, u32, 60);

    // Tick 66 IS a decimation tick (66 % 6 === 0). Both "a" (in interest)
    // and "b" (out of interest) should ship — "b" specifically because the
    // decimation cadence fires regardless of poseChanged.
    const inInterest = new Set<number>([inA.entityId]);
    const packet = encoder.encode(registry, f32, u32, 66, inInterest);
    expect(packet).not.toBeNull();
    expect(new DataView(packet!.buffer, packet!.byteOffset).getUint16(2, true)).toBe(2);
  });

  it('inInterest=undefined preserves Phase 5c broadcast-all behaviour', () => {
    registry.register('a', SLOT_A, 0, 32, 0, 0, 0);
    registry.register('b', SLOT_B, 0, 32, 100, 0, 0);
    setSlotPose(f32, SLOT_A, 0, 0, 1.0, 0, 0);
    setSlotPose(f32, SLOT_B, 100, 0, 1.0, 0, 0);

    encoder.encode(registry, f32, u32, 60);

    setSlotPose(f32, SLOT_A, 1, 0, 1.0, 0, 0);
    setSlotPose(f32, SLOT_B, 101, 0, 1.0, 0, 0);
    const packet = encoder.encode(registry, f32, u32, 61); // no filter
    expect(packet).not.toBeNull();
    expect(new DataView(packet!.buffer, packet!.byteOffset).getUint16(2, true)).toBe(2);
  });

  it('encodes a STRUCTURE subtype into the shared shipKind byte (Phase 2)', () => {
    // kind=2 (structure); rec.shipKind holds the structure-kind id.
    const rec = registry.register('struct-0', SLOT_A, 2, 36, 100, 200, 0);
    rec.shipKind = 'turret';
    setSlotPose(f32, SLOT_A, 100, 200, 0, 0, 0);

    const packet = encoder.encode(registry, f32, u32, 60); // full-snapshot tick
    expect(packet).not.toBeNull();
    const view = new DataView(packet!.buffer, packet!.byteOffset, packet!.byteLength);
    // First (only) record's kind + subtype byte.
    expect(view.getUint8(SWARM_HEADER_BYTES + 2)).toBe(SWARM_KIND_STRUCTURE);
    expect(view.getUint8(SWARM_HEADER_BYTES + SWARM_REC_SHIP_KIND_OFF)).toBe(
      structureKindToIndex('turret'),
    );
    // componentIndex byte is 0 for non-scrap records.
    expect(view.getUint8(SWARM_HEADER_BYTES + SWARM_REC_COMPONENT_INDEX_OFF)).toBe(0);
  });

  it('header carries the bumped wire version (v4) and the 34-byte stride', () => {
    expect(SWARM_WIRE_VERSION).toBe(4);
    expect(SWARM_RECORD_BYTES).toBe(34);
    expect(SWARM_REC_COMPONENT_INDEX_OFF).toBe(33);
    registry.register('a', SLOT_A, 0, 32, 0, 0, 0);
    setSlotPose(f32, SLOT_A, 1, 0, 0, 0, 0);
    const packet = encoder.encode(registry, f32, u32, 60);
    expect(packet).not.toBeNull();
    const view = new DataView(packet!.buffer, packet!.byteOffset, packet!.byteLength);
    expect(view.getUint8(0)).toBe(4);
    expect(packet!.byteLength).toBe(SWARM_HEADER_BYTES + SWARM_RECORD_BYTES);
  });

  it('encodes a SCRAP record: parent ship-kind into the shared byte + componentIndex (Phase 2a)', () => {
    // kind=3 (scrap); rec.shipKind holds the PARENT ship-kind id, componentIndex
    // selects which scrap group of that parent this piece is.
    const rec = registry.register('scrap-0', SLOT_A, SWARM_KIND_SCRAP, 8, 100, 200, 0);
    rec.shipKind = 'havok';
    rec.componentIndex = 5;
    setSlotPose(f32, SLOT_A, 100, 200, 0, 0, 0);

    const packet = encoder.encode(registry, f32, u32, 60); // full-snapshot tick
    expect(packet).not.toBeNull();
    const view = new DataView(packet!.buffer, packet!.byteOffset, packet!.byteLength);
    expect(view.getUint8(SWARM_HEADER_BYTES + 2)).toBe(SWARM_KIND_SCRAP);
    // Shared byte carries the PARENT ship-kind index.
    expect(view.getUint8(SWARM_HEADER_BYTES + SWARM_REC_SHIP_KIND_OFF)).toBe(
      shipKindToIndex('havok'),
    );
    // Trailing componentIndex byte carries which scrap group.
    expect(view.getUint8(SWARM_HEADER_BYTES + SWARM_REC_COMPONENT_INDEX_OFF)).toBe(5);
  });
});
