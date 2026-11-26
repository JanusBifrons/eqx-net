/**
 * Base platforms slice 15: structures turn in 30° steps. The rotation is
 * degrees on the message, the registry and the save, and radians on the swarm
 * wire's f32 angle; the client reads it back with `normaliseStructureRotation`.
 * Two-sided (invariant 15): every one of the twelve turns goes through the REAL
 * server encoder and the REAL client decoder and comes back the same, and the
 * old quarter turns keep their values (saved games face the same way).
 */
import { describe, it, expect } from 'vitest';
import { BinarySwarmBroadcast } from '../../src/server/net/BinarySwarmBroadcast.js';
import { SwarmEntityRegistry } from '../../src/server/net/SwarmEntityRegistry.js';
import { decodeSwarmPacket } from '../../src/client/net/BinarySwarmDecoder.js';
import type { RenderMirror } from '../../src/core/contracts/IRenderer.js';
import { SAB_TOTAL_BYTES, slotBase, SLOT_X_OFF, SLOT_Y_OFF, SLOT_ANGLE_OFF } from '../../src/shared-types/sabLayout.js';
import { SWARM_KIND_STRUCTURE } from '../../src/shared-types/swarmWireFormat.js';
import {
  STRUCTURE_ROTATIONS,
  normaliseStructureRotation,
  normaliseStructureQuarterTurn,
  snapPlayerStructureRotation,
  playerStructureRotationStep,
  structureHalfExtents,
} from '../../src/shared-types/structureKinds.js';
import { keepClearBox } from '../../src/core/structures/placementRules.js';
import { PlaceStructureSchema } from '../../src/shared-types/messages/clientMessages.js';

const DEG = Math.PI / 180;

describe('structure rotation — 30° steps (base platforms 15)', () => {
  it('twelve rotations; the quarter turns keep their degree values', () => {
    expect(STRUCTURE_ROTATIONS.length).toBe(12);
    for (const q of [0, 90, 180, 270]) expect(normaliseStructureRotation(q)).toBe(q);
    expect(normaliseStructureRotation(30)).toBe(30);
    expect(normaliseStructureRotation(-30)).toBe(330);
    expect(normaliseStructureRotation(390)).toBe(30);
    expect(normaliseStructureQuarterTurn(30)).toBe(0);
    expect(normaliseStructureQuarterTurn(60)).toBe(90);
  });

  it('a player turn snaps by the room rule: 30° on a deck room, quarters elsewhere', () => {
    expect(playerStructureRotationStep(true)).toBe(30);
    expect(playerStructureRotationStep(false)).toBe(90);
    expect(snapPlayerStructureRotation(30, true)).toBe(30);
    expect(snapPlayerStructureRotation(30, false)).toBe(0);
    expect(snapPlayerStructureRotation(150, false)).toBe(180);
    expect(snapPlayerStructureRotation(undefined, true)).toBe(0);
  });

  it('place_structure carries a 30° rot through the zod schema', () => {
    const r = PlaceStructureSchema.safeParse({ type: 'place_structure', kind: 'solar', x: 0, y: 0, rot: 30 });
    expect(r.success).toBe(true);
    expect(r.success && r.data.rot).toBe(30);
  });

  it('half extents: quarter turns unchanged; an odd 30° turn uses the nearest quarter (axis-aligned until bp-16)', () => {
    expect(structureHalfExtents('solar', 0)).toEqual({ hw: 350, hh: 150 });
    expect(structureHalfExtents('solar', 90)).toEqual({ hw: 150, hh: 350 });
    expect(structureHalfExtents('solar', 30)).toEqual({ hw: 350, hh: 150 });
    expect(structureHalfExtents('solar', 60)).toEqual({ hw: 150, hh: 350 });
    expect(structureHalfExtents('solar', 150)).toEqual({ hw: 350, hh: 150 });
  });

  it('a keepClear pad offset (the Capital crane bay) turns by the real 30° angle; quarter turns stay exact', () => {
    const at0 = { ...keepClearBox('capital', 0, 0, 0)! };
    const at90 = { ...keepClearBox('capital', 0, 0, 90)! };
    const at30 = { ...keepClearBox('capital', 0, 0, 30)! };
    // Quarter turn: (x, y) → (−y, x), exactly.
    expect(at90.x).toBe(-at0.y);
    expect(at90.y).toBe(at0.x);
    const len = Math.hypot(at0.x, at0.y);
    expect(Math.hypot(at30.x, at30.y)).toBeCloseTo(len, 6);
    expect(Math.atan2(at30.y, at30.x) - Math.atan2(at0.y, at0.x)).toBeCloseTo(30 * DEG, 6);
  });

  it('two-sided: every rotation survives server angle → swarm encode → client decode → degrees', () => {
    const registry = new SwarmEntityRegistry();
    const encoder = new BinarySwarmBroadcast();
    const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
    const f32 = new Float32Array(sab), u32 = new Uint32Array(sab);
    const ids: number[] = [];
    STRUCTURE_ROTATIONS.forEach((rot, i) => {
      // The server's spawn angle for a placed structure (StructurePlacementSubsystem).
      const angle = (rot * Math.PI) / 180;
      const rec = registry.register(`s-${rot}`, i + 1, SWARM_KIND_STRUCTURE, 36, i * 1000, 0, angle);
      rec.shipKind = 'solar';
      const b = slotBase(i + 1);
      f32[b + SLOT_X_OFF] = i * 1000; f32[b + SLOT_Y_OFF] = 0; f32[b + SLOT_ANGLE_OFF] = angle;
      ids.push(rec.entityId);
    });
    const packet = encoder.encode(registry, f32, u32, 60);
    expect(packet).not.toBeNull();
    const mirror: RenderMirror = { ships: new Map(), localPlayerId: null };
    decodeSwarmPacket(packet!, mirror);
    STRUCTURE_ROTATIONS.forEach((rot, i) => {
      const e = mirror.swarm!.get(ids[i]!)!;
      // The client's read (placementGhostVerdict / mirrorToGridNode).
      expect(normaliseStructureRotation((e.angle * 180) / Math.PI), `rot ${rot}`).toBe(rot);
    });
  });
});
