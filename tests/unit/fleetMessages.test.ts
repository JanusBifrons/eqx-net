/**
 * RTS command layer slice 6a — fleet command wire schemas.
 * Accept/reject cases + parity with the core wingman vocabulary (#15).
 */
import { describe, it, expect } from 'vitest';
import {
  ClientMessageSchema,
  CommandSchema,
  DisbandSquadSchema,
  FleetOrderSchema,
  FormSquadSchema,
  SetModeSchema,
  SetStanceSchema,
  WingmanModeSchema,
  WingmanStanceSchema,
} from '../../src/shared-types/messages.js';
import { WINGMAN_MODES, WINGMAN_STANCES } from '../../src/core/ai/wingman/types.js';

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i}`);

describe('fleet command schemas', () => {
  it('mode/stance enums mirror the core wingman vocabulary', () => {
    expect([...WingmanModeSchema.options]).toEqual([...WINGMAN_MODES]);
    expect([...WingmanStanceSchema.options]).toEqual([...WINGMAN_STANCES]);
  });

  it('fleet_order: accepts move/attack/stop', () => {
    expect(FleetOrderSchema.safeParse({ type: 'fleet_order', shipIds: ['a'], kind: 'move', x: 1, y: -2 }).success).toBe(true);
    expect(FleetOrderSchema.safeParse({ type: 'fleet_order', shipIds: ['a'], kind: 'attack', targetId: 't' }).success).toBe(true);
    expect(FleetOrderSchema.safeParse({ type: 'fleet_order', shipIds: ['a'], kind: 'stop' }).success).toBe(true);
  });

  it('fleet_order: rejects move without x/y, attack without target, NaN, bad id counts', () => {
    const bad = [
      { type: 'fleet_order', shipIds: ['a'], kind: 'move', x: 1 },
      { type: 'fleet_order', shipIds: ['a'], kind: 'attack' },
      { type: 'fleet_order', shipIds: ['a'], kind: 'move', x: NaN, y: 0 },
      { type: 'fleet_order', shipIds: ['a'], kind: 'move', x: Infinity, y: 0 },
      { type: 'fleet_order', shipIds: [], kind: 'stop' },
      { type: 'fleet_order', shipIds: ids(65), kind: 'stop' },
      { type: 'fleet_order', shipIds: ['x'.repeat(65)], kind: 'stop' },
      { type: 'fleet_order', shipIds: ['a'], kind: 'dance' },
      { type: 'fleet_order', shipIds: ['a'], kind: 'stop', extra: 1 },
    ];
    for (const m of bad) expect(FleetOrderSchema.safeParse(m).success, JSON.stringify(m)).toBe(false);
    expect(FleetOrderSchema.safeParse({ type: 'fleet_order', shipIds: ids(64), kind: 'stop' }).success).toBe(true);
  });

  it('set_mode: accepts params, rejects bad mode / long route / bad radius', () => {
    const route = Array.from({ length: 16 }, (_, i) => [i, i] as [number, number]);
    expect(SetModeSchema.safeParse({ type: 'set_mode', shipIds: ['a'], mode: 'patrol', route }).success).toBe(true);
    expect(SetModeSchema.safeParse({ type: 'set_mode', shipIds: ['a'], mode: 'defend', guardRadius: 500 }).success).toBe(true);
    expect(SetModeSchema.safeParse({ type: 'set_mode', shipIds: ['a'], mode: 'escort', escortId: 'e' }).success).toBe(true);
    expect(SetModeSchema.safeParse({ type: 'set_mode', shipIds: ['a'], mode: 'retreat', x: 120, y: -40 }).success).toBe(true);
    const bad = [
      { type: 'set_mode', shipIds: ['a'], mode: 'berserk' },
      { type: 'set_mode', shipIds: ['a'], mode: 'patrol', route: [...route, [0, 0]] },
      { type: 'set_mode', shipIds: ['a'], mode: 'patrol', route: [[NaN, 0]] },
      { type: 'set_mode', shipIds: ['a'], mode: 'defend', guardRadius: 0 },
      { type: 'set_mode', shipIds: ['a'], mode: 'retreat', x: NaN, y: 0 },
      { type: 'set_mode', shipIds: ['a'], mode: 'defend', guardRadius: Infinity },
      { type: 'set_mode', shipIds: ids(65), mode: 'defend' },
    ];
    for (const m of bad) expect(SetModeSchema.safeParse(m).success, JSON.stringify(m)).toBe(false);
  });

  it('set_stance / form_squad / disband_squad / command', () => {
    expect(SetStanceSchema.safeParse({ type: 'set_stance', shipIds: ['a'], stance: 'holdFire' }).success).toBe(true);
    expect(SetStanceSchema.safeParse({ type: 'set_stance', shipIds: ['a'], stance: 'yolo' }).success).toBe(false);
    expect(FormSquadSchema.safeParse({ type: 'form_squad', shipIds: ['a'] }).success).toBe(false);
    expect(FormSquadSchema.safeParse({ type: 'form_squad', shipIds: ids(2) }).success).toBe(true);
    expect(FormSquadSchema.safeParse({ type: 'form_squad', shipIds: ids(25) }).success).toBe(false);
    expect(DisbandSquadSchema.safeParse({ type: 'disband_squad', squadId: 'q' }).success).toBe(true);
    expect(DisbandSquadSchema.safeParse({ type: 'disband_squad', squadId: '' }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: 'command' }).success).toBe(true);
    expect(CommandSchema.safeParse({ type: 'command', x: 1 }).success).toBe(false);
  });

  it('all are registered in ClientMessageSchema', () => {
    for (const m of [
      { type: 'fleet_order', shipIds: ['a'], kind: 'stop' },
      { type: 'set_mode', shipIds: ['a'], mode: 'hunt' },
      { type: 'set_stance', shipIds: ['a'], stance: 'aggressive' },
      { type: 'form_squad', shipIds: ['a', 'b'] },
      { type: 'disband_squad', squadId: 'q' },
      { type: 'command' },
    ]) expect(ClientMessageSchema.safeParse(m).success, m.type).toBe(true);
  });
});
