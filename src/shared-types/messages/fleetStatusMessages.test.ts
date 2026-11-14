import { describe, it, expect } from 'vitest';
import {
  FLEET_STATUS_ACTIVITIES,
  FLEET_STATUS_MODES,
  FLEET_STATUS_MORALE,
  FLEET_STATUS_STANCES,
  FleetStatusMessageSchema,
  decodeFleetStatusRow,
  encodeFleetStatusRow,
  type FleetStatusRowWire,
} from './fleetStatusMessages.js';
import { WINGMAN_MODES, WINGMAN_STANCES, type WingmanActivity } from '../../core/ai/wingman/types.js';
import { MORALE_OUTCOME } from '../../core/ai/tactics/morale.js';

describe('fleet_status wire format', () => {
  it('round-trips a full row through encode → schema → decode', () => {
    const row: FleetStatusRowWire = {
      id: 'ship-1',
      mode: 'patrol',
      stance: 'holdFire',
      activity: 'patrolling',
      targetId: 's:42',
      hullPct: 63,
      moraleOutcome: 'fallBack',
      squadId: 'sq-1',
      orderKind: 'move',
      orderX: 120.5,
      orderY: -40,
      escortId: 'ship-2',
      route: [[0, 0], [100, 0], [100, 100]],
    };
    const msg = { type: 'fleet_status' as const, s: [encodeFleetStatusRow(row)] };
    const parsed = FleetStatusMessageSchema.parse(JSON.parse(JSON.stringify(msg)));
    expect(decodeFleetStatusRow(parsed.s[0]!)).toEqual(row);
  });

  it('round-trips a minimal row (no optional fields)', () => {
    const row: FleetStatusRowWire = { id: 'h', mode: 'defend', stance: 'defensive', activity: 'guarding', targetId: null, hullPct: 100 };
    const parsed = FleetStatusMessageSchema.parse({ type: 'fleet_status', s: [encodeFleetStatusRow(row)] });
    expect(decodeFleetStatusRow(parsed.s[0]!)).toEqual(row);
  });

  it('rejects out-of-range indices and extra keys', () => {
    const t = encodeFleetStatusRow({ id: 'h', mode: 'defend', stance: 'defensive', activity: 'idle', targetId: null, hullPct: 50 });
    const bad = [...t] as unknown[];
    bad[1] = FLEET_STATUS_MODES.length;
    expect(FleetStatusMessageSchema.safeParse({ type: 'fleet_status', s: [bad] }).success).toBe(false);
    expect(FleetStatusMessageSchema.safeParse({ type: 'fleet_status', s: [], x: 1 }).success).toBe(false);
  });

  it('enum tables match the core wingman types (#15)', () => {
    expect([...FLEET_STATUS_MODES]).toEqual([...WINGMAN_MODES]);
    expect([...FLEET_STATUS_STANCES]).toEqual([...WINGMAN_STANCES]);
    // Compile-time: every table entry is a WingmanActivity.
    const acts: readonly WingmanActivity[] = FLEET_STATUS_ACTIVITIES;
    expect(acts.length).toBe(8);
    expect(FLEET_STATUS_MORALE[MORALE_OUTCOME.FightOn]).toBe('fightOn');
    expect(FLEET_STATUS_MORALE[MORALE_OUTCOME.FallBack]).toBe('fallBack');
    expect(FLEET_STATUS_MORALE[MORALE_OUTCOME.Flee]).toBe('flee');
  });
});
