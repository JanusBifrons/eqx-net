/**
 * Binary swarm wire — REAL encoder → REAL decoder round-trip (plan:
 * misty-teapot, P1: structures/scrap correctness in the deterministic suite).
 *
 * The existing split locks are strong but isolated: `BinarySwarmBroadcast.test.ts`
 * asserts the ENCODER writes the right bytes at the published offsets, and
 * `BinarySwarmDecoder.test.ts` asserts the DECODER reads HAND-WRITTEN bytes at
 * those same offsets (it deliberately avoids importing the server encoder to
 * keep zone purity). Neither runs the encoder's ACTUAL output through the
 * decoder — so an encoder/decoder DISAGREEMENT not captured by the shared
 * offset constant (a field read from the wrong record slot, a pose-flow bug)
 * would pass both.
 *
 * This is the integration lock the hostile review (2026-06-15) asked for: the
 * netgate's local-player metrics CANNOT detect a wrong scrap `componentIndex`
 * or a corrupted structures encode (those move no prediction metric, and the
 * lossless proxy never drops a late/bloated payload), so structures/scrap WIRE
 * correctness must be gated HERE, deterministically, every PR. A test crossing
 * the src/server↔src/client boundary is legal (boundary rules bind src/**, not
 * tests/).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BinarySwarmBroadcast } from '../../src/server/net/BinarySwarmBroadcast.js';
import { SwarmEntityRegistry } from '../../src/server/net/SwarmEntityRegistry.js';
import { decodeSwarmPacket } from '../../src/client/net/BinarySwarmDecoder.js';
import type { RenderMirror } from '../../src/core/contracts/IRenderer.js';
import {
  SAB_TOTAL_BYTES,
  slotBase,
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGLE_OFF,
  SLOT_ANGVEL_OFF,
} from '../../src/shared-types/sabLayout.js';
import {
  SWARM_KIND_STRUCTURE,
  SWARM_KIND_SCRAP,
} from '../../src/shared-types/swarmWireFormat.js';

function makeSab(): { f32: Float32Array; u32: Uint32Array } {
  const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
  return { f32: new Float32Array(sab), u32: new Uint32Array(sab) };
}

function setSlotPose(
  f32: Float32Array,
  slot: number,
  x: number,
  y: number,
  angle: number,
): void {
  const b = slotBase(slot);
  f32[b + SLOT_X_OFF] = x;
  f32[b + SLOT_Y_OFF] = y;
  f32[b + SLOT_VX_OFF] = 0;
  f32[b + SLOT_VY_OFF] = 0;
  f32[b + SLOT_ANGLE_OFF] = angle;
  f32[b + SLOT_ANGVEL_OFF] = 0;
}

describe('binary swarm wire — encoder→decoder round-trip (structures + scrap)', () => {
  let registry: SwarmEntityRegistry;
  let encoder: BinarySwarmBroadcast;
  let f32: Float32Array;
  let u32: Uint32Array;

  beforeEach(() => {
    registry = new SwarmEntityRegistry();
    encoder = new BinarySwarmBroadcast();
    ({ f32, u32 } = makeSab());
  });

  it('a structure (kind 2), a scrap piece (kind 3) and a drone (kind 1) survive a real encode→decode', () => {
    // Structure: subtype rides the shared shipKind byte.
    const struct = registry.register('struct-0', 5, SWARM_KIND_STRUCTURE, 36, 100, 200, 0.5);
    struct.shipKind = 'turret';
    setSlotPose(f32, 5, 100, 200, 0.5);

    // Scrap: shared byte = PARENT ship-kind; trailing byte = componentIndex.
    const scrap = registry.register('scrap-0', 7, SWARM_KIND_SCRAP, 8, -50, 25, 1.25);
    scrap.shipKind = 'havok';
    scrap.componentIndex = 5;
    setSlotPose(f32, 7, -50, 25, 1.25);

    // Drone: shared byte = its own ship-kind; componentIndex meaningless.
    const drone = registry.register('drone-0', 9, 1, 14, 300, -400, -0.75);
    drone.shipKind = 'fighter';
    drone.componentIndex = 9; // must be IGNORED on decode (kind !== 3)
    setSlotPose(f32, 9, 300, -400, -0.75);

    const packet = encoder.encode(registry, f32, u32, 60); // first call ⇒ full snapshot
    expect(packet, 'encoder produced a full-snapshot packet').not.toBeNull();

    const mirror: RenderMirror = { ships: new Map(), localPlayerId: null };
    decodeSwarmPacket(packet!, mirror);

    // ── structure ──────────────────────────────────────────────────────────
    const ds = mirror.swarm!.get(struct.entityId)!;
    expect(ds, 'structure decoded').toBeTruthy();
    expect(ds.kind).toBe(SWARM_KIND_STRUCTURE);
    expect(ds.shipKind).toBe('turret');
    expect(ds.x).toBeCloseTo(100, 1);
    expect(ds.y).toBeCloseTo(200, 1);
    expect(ds.componentIndex).toBeUndefined(); // not a scrap record

    // ── scrap (the hostile-review headline: componentIndex must survive) ─────
    const dc = mirror.swarm!.get(scrap.entityId)!;
    expect(dc, 'scrap decoded').toBeTruthy();
    expect(dc.kind).toBe(SWARM_KIND_SCRAP);
    expect(dc.shipKind).toBe('havok'); // parent ship-kind via the shared byte
    expect(dc.componentIndex).toBe(5); // the wire byte the netgate can't gate
    expect(dc.x).toBeCloseTo(-50, 1);
    expect(dc.y).toBeCloseTo(25, 1);

    // ── drone ────────────────────────────────────────────────────────────────
    const dd = mirror.swarm!.get(drone.entityId)!;
    expect(dd, 'drone decoded').toBeTruthy();
    expect(dd.kind).toBe(1);
    expect(dd.shipKind).toBe('fighter');
    // A non-scrap record leaves componentIndex undefined even though the byte
    // was set — the demux is on `kind`, exactly as the wire contract requires.
    expect(dd.componentIndex).toBeUndefined();
  });
});
