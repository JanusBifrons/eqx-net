import { describe, it, expect } from 'vitest';
import {
  FLEET_STATUS_ACTIVITIES,
  FLEET_STATUS_MODES,
  FLEET_STATUS_STANCES,
  FleetStatusMessageSchema,
  decodeFleetStatusRow,
  encodeFleetStatusRow,
  type FleetStatusRowWire,
} from './fleetStatusMessages.js';

describe('fleet_status wire format', () => {
  it('round-trips a full row through encode → schema → decode', () => {
    const row: FleetStatusRowWire = {
      id: 'ship-1',
      mode: 'patrol',
      stance: 'holdFire',
      activity: 'patrolling',
      targetId: 's:42',
      shieldPct: 40,
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
    const row: FleetStatusRowWire = { id: 'h', mode: 'defend', stance: 'defensive', activity: 'guarding', targetId: null };
    const parsed = FleetStatusMessageSchema.parse({ type: 'fleet_status', s: [encodeFleetStatusRow(row)] });
    expect(decodeFleetStatusRow(parsed.s[0]!)).toEqual(row);
  });

  it('hull and morale slots are retired (RTS Part A): never filled, and an older sender still parses', () => {
    const t = encodeFleetStatusRow({ id: 'h', mode: 'defend', stance: 'defensive', activity: 'idle', targetId: null });
    expect(t[5]).toBeNull();
    expect(t[6]).toBe(-1);
    // An older sender filled them: still valid, and the decoder ignores them.
    const old = [...t] as unknown[];
    old[5] = 63;
    old[6] = 1;
    const parsed = FleetStatusMessageSchema.safeParse({ type: 'fleet_status', s: [old] });
    expect(parsed.success).toBe(true);
    const row = decodeFleetStatusRow(parsed.success ? parsed.data.s[0]! : t);
    expect('hullPct' in row).toBe(false);
    expect('moraleOutcome' in row).toBe(false);
  });

  it('rejects out-of-range indices and extra keys', () => {
    const t = encodeFleetStatusRow({ id: 'h', mode: 'defend', stance: 'defensive', activity: 'idle', targetId: null });
    const bad = [...t] as unknown[];
    bad[1] = FLEET_STATUS_MODES.length;
    expect(FleetStatusMessageSchema.safeParse({ type: 'fleet_status', s: [bad] }).success).toBe(false);
    expect(FleetStatusMessageSchema.safeParse({ type: 'fleet_status', s: [], x: 1 }).success).toBe(false);
  });

  it('enum tables are wire indices: order locked (append-only)', () => {
    expect([...FLEET_STATUS_MODES]).toEqual(['patrol', 'defend', 'hunt', 'escort', 'retreat']);
    expect([...FLEET_STATUS_STANCES]).toEqual(['aggressive', 'defensive', 'holdFire']);
    expect(FLEET_STATUS_ACTIVITIES.slice(0, 8)).toEqual(
      ['idle', 'moving', 'patrolling', 'chasing', 'attacking', 'retreating', 'formingUp', 'guarding'],
    );
    expect(FLEET_STATUS_ACTIVITIES.length).toBe(10); // + searching (RTS Part B slice 9), blocked (navigation slice 9)
    expect(FLEET_STATUS_ACTIVITIES[9]).toBe('blocked');
  });
});
