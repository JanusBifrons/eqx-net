/**
 * Solid doors slice 11 (docs/plans/door-power.md) — the live deck light. The
 * gate / airlock `BodyStatusHook` reads the DECODED door segments (the door
 * row, `decodeDoorRow`) at the rig clock: green only when fully open, red
 * shut or moving, dark unpowered. An airlock's two strip pairs follow their
 * own ends.
 */
import { describe, expect, it } from 'vitest';
import { GraphicsContext } from 'pixi.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import { DOOR_POS_MAX, DOOR_POWER_LEVELS, DOOR_TRAVEL_TICKS } from '../../../core/structures/gateGeometry.js';
import { encodeDoorMotion, type DoorMotionSeg } from '../../../shared-types/structureStateWire.js';
import { decodeDoorRow } from '../../net/doorMotionDecode.js';
import {
  DECK_END_DARK, DECK_END_OPEN, DECK_END_SHUT, deckEndState, deckLightCode, doorStatus,
} from './structureStyleC.fences.gate.js';
import { status } from './structureStyleC.fences.js';
import { bodyStatusCode, hasBodyStatus, socketNubContext } from './structureSocketNubs.js';

const FULL = DOOR_POWER_LEVELS;

/** A built, powered door row decoded from the wire fields of `seg` (clip 0 =
 *  the gate / airlock end A, 1 = airlock end B). */
function row(kind: string, seg: DoorMotionSeg, clip = 0, powered = true): StructureRenderState {
  const f = encodeDoorMotion(seg, clip, { rigClip: 0, rigStart: 0, rigHold: 0, gateOpen: 0 });
  const out = { powered, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0 } as unknown as StructureRenderState;
  decodeDoorRow(f, out, kind);
  return out;
}

const opening = (t0 = 100, level = FULL): DoorMotionSeg => ({ p0: 0, t0, dir: 1, level });
const closing = (t0 = 100, level = FULL): DoorMotionSeg => ({ p0: DOOR_POS_MAX, t0, dir: -1, level });

describe('live deck light (door slice 11)', () => {
  it('gate: red while shut and while opening, green only once fully open', () => {
    const st = row('shield_gate', opening());
    expect(deckLightCode('shield_gate', st, 50)).toBe(1 + DECK_END_SHUT); // before t0: shut
    expect(deckLightCode('shield_gate', st, 100 + DOOR_TRAVEL_TICKS - 1)).toBe(1 + DECK_END_SHUT); // moving
    expect(deckLightCode('shield_gate', st, 100 + DOOR_TRAVEL_TICKS)).toBe(1 + DECK_END_OPEN);
    expect(deckLightCode('shield_gate', st, 100 + 10 * DOOR_TRAVEL_TICKS)).toBe(1 + DECK_END_OPEN);
  });

  it('gate: closing from fully open is red at once', () => {
    const st = row('shield_gate', closing());
    expect(deckLightCode('shield_gate', st, 100)).toBe(1 + DECK_END_SHUT);
    expect(deckLightCode('shield_gate', st, 100 + DOOR_TRAVEL_TICKS)).toBe(1 + DECK_END_SHUT);
  });

  it('dark when unpowered, or stalled mid-travel at level 0; a still shut door stays red', () => {
    expect(deckLightCode('shield_gate', row('shield_gate', opening(), 0, false), 1000)).toBe(1 + DECK_END_DARK);
    const stalled: DoorMotionSeg = { p0: 900, t0: 100, dir: 1, level: 0 };
    expect(deckLightCode('shield_gate', row('shield_gate', stalled), 1000)).toBe(1 + DECK_END_DARK);
    const still: DoorMotionSeg = { p0: 0, t0: 0, dir: -1, level: 0 };
    expect(deckLightCode('shield_gate', row('shield_gate', still), 1000)).toBe(1 + DECK_END_SHUT);
    expect(deckEndState(undefined, true, 0)).toBe(DECK_END_SHUT);
  });

  it('not built / no row: code 0 (the baked strips show)', () => {
    const st = row('shield_gate', opening());
    st.built = false;
    expect(deckLightCode('shield_gate', st, 1000)).toBe(0);
    expect(deckLightCode('shield_gate', undefined, 1000)).toBe(0);
  });

  it('airlock: each end follows its own door (end B open, end A shut)', () => {
    const t = 100 + DOOR_TRAVEL_TICKS;
    const b = row('shield_airlock', opening(), 1);
    expect(deckLightCode('shield_airlock', b, t)).toBe(1 + DECK_END_SHUT + 3 * DECK_END_OPEN);
    const a = row('shield_airlock', opening(), 0);
    expect(deckLightCode('shield_airlock', a, t)).toBe(1 + DECK_END_OPEN + 3 * DECK_END_SHUT);
    expect(deckLightCode('shield_airlock', row('shield_airlock', opening(), 1, false), t)).toBe(1);
  });

  it('wired through the existing BodyStatusHook: fences family status, nub overlay code, drawn per code', () => {
    expect(status.shield_gate).toBe(doorStatus);
    expect(status.shield_airlock).toBe(doorStatus);
    expect(hasBodyStatus('shield_gate')).toBe(true);
    const st = row('shield_gate', opening());
    expect(bodyStatusCode('shield_gate', st, 100 + DOOR_TRAVEL_TICKS)).toBe(1 + DECK_END_OPEN);
    expect(bodyStatusCode('shield_gate', st, 100)).toBe(1 + DECK_END_SHUT);
    const g = new GraphicsContext();
    doorStatus.draw(g, 1 + DECK_END_OPEN, 'shield_gate');
    expect(g.instructions.length).toBeGreaterThan(0);
    // One shared context per code: the same code reuses it.
    expect(socketNubContext('shield_airlock', 0, 7)).toBe(socketNubContext('shield_airlock', 0, 7));
  });
});
