import { describe, it, expect } from 'vitest';
import { decodeSwarmPacket } from './BinarySwarmDecoder.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';
import {
  SWARM_HEADER_BYTES, SWARM_RECORD_BYTES,
  SWARM_REC_ANGVEL_OFF,
  SWARM_REC_RADIUS_OFF,
  SWARM_REC_SHIP_KIND_OFF,
  SWARM_REC_COMPONENT_INDEX_OFF,
  SWARM_FLAG_FULL,
  SWARM_RECORD_FLAG_SLEEPING,
  SWARM_RECORD_FLAG_SHIELD_DOWN,
  SWARM_WIRE_VERSION,
  SWARM_KIND_STRUCTURE,
  SWARM_KIND_SCRAP,
} from '../../shared-types/swarmWireFormat.js';
import { structureKindToIndex } from '../../shared-types/structureKinds.js';
import { shipKindToIndex } from '../../shared-types/shipKinds.js';

interface SwarmRecord {
  entityId: number;
  kind: number;
  recFlags: number;
  x: number; y: number; vx: number; vy: number; angle: number; angvel: number; radius: number;
  /** Shared subtype byte (drone ship-kind index OR structure-kind index OR
   *  scrap parent-ship-kind index). */
  shipKindByte?: number;
  /** Trailing componentIndex byte — meaningful only for scrap (kind=3). */
  componentIndex?: number;
}

/**
 * Hand-build a wire packet matching the spec in `swarmWireFormat.ts`. This
 * avoids cross-zone imports (the decoder lives in `src/client` and cannot
 * pull in the encoder from `src/server`); the round-trip is implicit in
 * agreeing with the published byte layout.
 */
function buildPacket(tick: number, isFull: boolean, records: SwarmRecord[]): Uint8Array {
  const buf = new ArrayBuffer(SWARM_HEADER_BYTES + records.length * SWARM_RECORD_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, SWARM_WIRE_VERSION);
  view.setUint8(1, isFull ? SWARM_FLAG_FULL : 0);
  view.setUint16(2, records.length, true);
  view.setUint32(4, tick, true);
  let off = SWARM_HEADER_BYTES;
  for (const r of records) {
    view.setUint16(off + 0, r.entityId, true);
    view.setUint8(off + 2, r.kind);
    view.setUint8(off + 3, r.recFlags);
    view.setFloat32(off + 4, r.x, true);
    view.setFloat32(off + 8, r.y, true);
    view.setFloat32(off + 12, r.vx, true);
    view.setFloat32(off + 16, r.vy, true);
    view.setFloat32(off + 20, r.angle, true);
    view.setFloat32(off + SWARM_REC_ANGVEL_OFF, r.angvel, true);
    view.setFloat32(off + SWARM_REC_RADIUS_OFF, r.radius, true);
    view.setUint8(off + SWARM_REC_SHIP_KIND_OFF, r.shipKindByte ?? 0);
    view.setUint8(off + SWARM_REC_COMPONENT_INDEX_OFF, r.componentIndex ?? 0);
    off += SWARM_RECORD_BYTES;
  }
  return new Uint8Array(buf);
}

function makeMirror(): RenderMirror {
  return { ships: new Map(), localPlayerId: null };
}

describe('decodeSwarmPacket', () => {
  it('decodes the SHIELD_DOWN recordFlags bit into mirror.swarm[*].shieldDown (Phase 6)', () => {
    const mirror = makeMirror();
    const packet = buildPacket(99, true, [
      { entityId: 7, kind: 1, recFlags: SWARM_RECORD_FLAG_SHIELD_DOWN, x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 12 },
      { entityId: 8, kind: 1, recFlags: 0, x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 12 },
      { entityId: 9, kind: 1, recFlags: SWARM_RECORD_FLAG_SLEEPING | SWARM_RECORD_FLAG_SHIELD_DOWN, x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 12 },
    ]);
    decodeSwarmPacket(packet, mirror);
    expect(mirror.swarm!.get(7)!.shieldDown).toBe(true);
    expect(mirror.swarm!.get(8)!.shieldDown).toBe(false);
    // SHIELD_DOWN coexists with SLEEPING in the same recordFlags byte.
    expect(mirror.swarm!.get(9)!.shieldDown).toBe(true);
    expect(mirror.swarm!.get(9)!.sleeping).toBe(true);
  });
  it('decodes a STRUCTURE subtype from the shared shipKind byte into entry.shipKind (Phase 2)', () => {
    const mirror = makeMirror();
    const packet = buildPacket(60, true, [
      {
        entityId: 42,
        kind: SWARM_KIND_STRUCTURE,
        recFlags: 0,
        x: 100, y: 200, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 36,
        shipKindByte: structureKindToIndex('turret'),
      },
      // Asteroid (kind 0) ignores the byte even when non-zero.
      {
        entityId: 43,
        kind: 0,
        recFlags: 0,
        x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 32,
        shipKindByte: 3,
      },
    ]);
    decodeSwarmPacket(packet, mirror);
    const s = mirror.swarm!.get(42)!;
    expect(s.kind).toBe(SWARM_KIND_STRUCTURE);
    expect(s.shipKind).toBe('turret');
    expect(mirror.swarm!.get(43)!.shipKind).toBeUndefined();
  });

  it('decodes a SCRAP record: parent ship-kind + componentIndex (Phase 2a)', () => {
    const mirror = makeMirror();
    const packet = buildPacket(60, true, [
      {
        entityId: 77,
        kind: SWARM_KIND_SCRAP,
        recFlags: 0,
        x: 50, y: -25, vx: 1, vy: 2, angle: 0.3, angvel: 0, radius: 8,
        shipKindByte: shipKindToIndex('havok'),
        componentIndex: 5,
      },
      // A drone (kind 1) carries no componentIndex even when the byte is set.
      {
        entityId: 78,
        kind: 1,
        recFlags: 0,
        x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 14,
        shipKindByte: shipKindToIndex('fighter'),
        componentIndex: 9,
      },
    ]);
    decodeSwarmPacket(packet, mirror);
    const scrap = mirror.swarm!.get(77)!;
    expect(scrap.kind).toBe(SWARM_KIND_SCRAP);
    // The shared byte decodes to the PARENT ship-kind id.
    expect(scrap.shipKind).toBe('havok');
    expect(scrap.componentIndex).toBe(5);
    // A non-scrap record leaves componentIndex undefined.
    const drone = mirror.swarm!.get(78)!;
    expect(drone.shipKind).toBe('fighter');
    expect(drone.componentIndex).toBeUndefined();
  });

  it('rejects a v3 packet (wrong version → dropped, no fallback)', () => {
    const mirror = makeMirror();
    // Hand-build a v3-shaped packet: version byte 3, the old 33-byte stride.
    const V3_RECORD_BYTES = 33;
    const buf = new ArrayBuffer(SWARM_HEADER_BYTES + V3_RECORD_BYTES);
    const view = new DataView(buf);
    view.setUint8(0, 3); // v3 — the decoder hard-fails this
    view.setUint8(1, SWARM_FLAG_FULL);
    view.setUint16(2, 1, true);
    view.setUint32(4, 60, true);
    decodeSwarmPacket(buf, mirror);
    // The packet was dropped: mirror.swarm is never even lazily created.
    expect(mirror.swarm).toBeUndefined();
  });

  it('mirrors a full snapshot into mirror.swarm', () => {
    const mirror = makeMirror();
    const packet = buildPacket(60, true, [
      { entityId: 0, kind: 0, recFlags: 0, x: 100, y: 200, vx: 0.1, vy: 0.2, angle: 0.5, angvel: 0, radius: 32 },
      { entityId: 1, kind: 1, recFlags: 0, x: -50, y: 0, vx: -1, vy: 0, angle: 0, angvel: 0, radius: 14 },
    ]);
    decodeSwarmPacket(packet, mirror);

    expect(mirror.swarm).toBeDefined();
    expect(mirror.swarm!.size).toBe(2);
    const a = mirror.swarm!.get(0)!;
    expect(a.x).toBeCloseTo(100, 4);
    expect(a.angle).toBeCloseTo(0.5, 4);
    expect(a.kind).toBe(0);
    expect(a.radius).toBeCloseTo(32, 4);
    expect(a.sleeping).toBe(false);
    expect(a.lastUpdateTick).toBe(60);

    const b = mirror.swarm!.get(1)!;
    expect(b.kind).toBe(1);
    expect(b.radius).toBeCloseTo(14, 4);
  });

  it('full snapshot omitting an entity removes it from the mirror', () => {
    const mirror = makeMirror();
    decodeSwarmPacket(buildPacket(60, true, [
      { entityId: 0, kind: 0, recFlags: 0, x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 32 },
      { entityId: 1, kind: 0, recFlags: 0, x: 100, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 24 },
    ]), mirror);
    expect(mirror.swarm!.size).toBe(2);

    // Fresh full snapshot — entity 1 is gone.
    decodeSwarmPacket(buildPacket(120, true, [
      { entityId: 0, kind: 0, recFlags: 0, x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 32 },
    ]), mirror);
    expect(mirror.swarm!.size).toBe(1);
    expect(mirror.swarm!.has(0)).toBe(true);
    expect(mirror.swarm!.has(1)).toBe(false);
  });

  it('delta packet does NOT remove entities the server is silently keeping at last pose', () => {
    const mirror = makeMirror();
    decodeSwarmPacket(buildPacket(60, true, [
      { entityId: 0, kind: 0, recFlags: 0, x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 32 },
      { entityId: 1, kind: 0, recFlags: 0, x: 100, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 24 },
    ]), mirror);
    expect(mirror.swarm!.size).toBe(2);

    decodeSwarmPacket(buildPacket(61, false, [
      { entityId: 0, kind: 0, recFlags: 0, x: 0.06, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 32 },
    ]), mirror);
    expect(mirror.swarm!.size).toBe(2); // entity 1 still there
    expect(mirror.swarm!.get(0)!.x).toBeCloseTo(0.06, 4);
  });

  it('decodes the SLEEPING bit into entry.sleeping', () => {
    const mirror = makeMirror();
    decodeSwarmPacket(buildPacket(60, true, [
      { entityId: 0, kind: 0, recFlags: SWARM_RECORD_FLAG_SLEEPING, x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 32 },
    ]), mirror);
    expect(mirror.swarm!.get(0)!.sleeping).toBe(true);
  });

  it('rejects malformed packets silently (truncated, wrong version)', () => {
    const mirror = makeMirror();
    decodeSwarmPacket(new Uint8Array([1, 0, 0]), mirror); // shorter than header
    expect(mirror.swarm).toBeUndefined();

    const buf = new ArrayBuffer(8);
    new DataView(buf).setUint8(0, 99); // unknown version
    decodeSwarmPacket(buf, mirror);
    expect(mirror.swarm).toBeUndefined();
  });

  it('reuses entry objects on repeated decode (no per-tick allocation)', () => {
    const mirror = makeMirror();
    decodeSwarmPacket(buildPacket(60, true, [
      { entityId: 0, kind: 0, recFlags: 0, x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 32 },
    ]), mirror);
    const beforeRef = mirror.swarm!.get(0)!;
    decodeSwarmPacket(buildPacket(61, false, [
      { entityId: 0, kind: 0, recFlags: 0, x: 5, y: 0, vx: 0.1, vy: 0, angle: 0, angvel: 0, radius: 32 },
    ]), mirror);
    const afterRef = mirror.swarm!.get(0)!;
    expect(afterRef).toBe(beforeRef); // same object reference
    expect(afterRef.x).toBeCloseTo(5, 4);
  });

  // 5c-stabilise: each decode advances `prev*` to the previous "latest", and
  // stamps `latestArrivalMs = nowMs`. The renderer's interpolator reads these.

  it('first packet sets prev == latest (no interpolation window yet)', () => {
    const mirror = makeMirror();
    decodeSwarmPacket(buildPacket(60, true, [
      { entityId: 0, kind: 0, recFlags: 0, x: 100, y: 0, vx: 0, vy: 0, angle: 0.3, angvel: 0, radius: 32 },
    ]), mirror, 1000);
    const e = mirror.swarm!.get(0)!;
    expect(e.x).toBe(100);
    expect(e.prevX).toBe(100);
    expect(e.prevAngle).toBeCloseTo(0.3, 5);
    expect(e.latestArrivalMs).toBe(1000);
    expect(e.prevArrivalMs).toBe(1000);
  });

  it('second packet snapshots prev pose + arrival before stamping the latest', () => {
    const mirror = makeMirror();
    decodeSwarmPacket(buildPacket(60, true, [
      { entityId: 0, kind: 0, recFlags: 0, x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 32 },
    ]), mirror, 1000);
    decodeSwarmPacket(buildPacket(61, false, [
      { entityId: 0, kind: 0, recFlags: 0, x: 100, y: 50, vx: 5, vy: 0, angle: 0.5, angvel: 0, radius: 32 },
    ]), mirror, 1100);
    const e = mirror.swarm!.get(0)!;
    expect(e.prevX).toBe(0);
    expect(e.prevY).toBe(0);
    expect(e.prevAngle).toBe(0);
    expect(e.prevArrivalMs).toBe(1000);
    expect(e.x).toBe(100);
    expect(e.y).toBe(50);
    expect(e.latestArrivalMs).toBe(1100);
  });

  // v3 (2026-05-09 AI lockstep): angvel is now a wire-format field. The
  // decoder must surface it on entries and pose-ring slots so the client AI's
  // damping term sees the same `self.angvel` the server's AI sees.
  it('decodes angvel into entry.angvel and the latest pose-ring slot', () => {
    const mirror = makeMirror();
    decodeSwarmPacket(buildPacket(60, true, [
      { entityId: 0, kind: 1, recFlags: 0, x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 1.25, radius: 14 },
    ]), mirror, 1000);
    const e = mirror.swarm!.get(0)!;
    expect(e.angvel).toBeCloseTo(1.25, 5);
    // The first arrival populates poseRing[0]; ringHead advanced to 1.
    expect(e.poseRing[0]!.angvel).toBeCloseTo(1.25, 5);

    // A second packet pushes a new value; entry mirrors the latest, ring
    // slot at the new head carries it.
    decodeSwarmPacket(buildPacket(61, false, [
      { entityId: 0, kind: 1, recFlags: 0, x: 0, y: 0, vx: 0, vy: 0, angle: 0.05, angvel: -0.7, radius: 14 },
    ]), mirror, 1050);
    expect(e.angvel).toBeCloseTo(-0.7, 5);
    expect(e.poseRing[1]!.angvel).toBeCloseTo(-0.7, 5);
  });

  it('three packets: prev always reflects the second-most-recent', () => {
    const mirror = makeMirror();
    decodeSwarmPacket(buildPacket(60, true, [
      { entityId: 0, kind: 0, recFlags: 0, x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 32 },
    ]), mirror, 1000);
    decodeSwarmPacket(buildPacket(61, false, [
      { entityId: 0, kind: 0, recFlags: 0, x: 50, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 32 },
    ]), mirror, 1100);
    decodeSwarmPacket(buildPacket(62, false, [
      { entityId: 0, kind: 0, recFlags: 0, x: 100, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 32 },
    ]), mirror, 1200);
    const e = mirror.swarm!.get(0)!;
    expect(e.prevX).toBe(50);
    expect(e.prevArrivalMs).toBe(1100);
    expect(e.x).toBe(100);
    expect(e.latestArrivalMs).toBe(1200);
  });
});
