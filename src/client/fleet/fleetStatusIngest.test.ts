import { describe, it, expect, beforeEach } from 'vitest';
import { ingestFleetStatus } from './fleetStatusIngest.js';
import { getFleetStatus, getFleetStatusVersion, resetFleetStatus } from './fleetStatus.js';
import { encodeFleetStatusRow } from '@shared-types/messages';

describe('ingestFleetStatus (fleet_status handler)', () => {
  beforeEach(() => resetFleetStatus());

  it('decodes rows into the status singleton, mapping every field', () => {
    const ok = ingestFleetStatus({
      type: 'fleet_status',
      s: [
        encodeFleetStatusRow({
          id: 'h1', mode: 'patrol', stance: 'aggressive', activity: 'patrolling', targetId: null,
          route: [[1, 2], [3, 4]],
        }),
        encodeFleetStatusRow({
          id: 'h2', mode: 'escort', stance: 'defensive', activity: 'moving', targetId: 's:9',
          orderKind: 'move', orderX: 50, orderY: 60, escortId: 'h1', squadId: 'sq-3',
        }),
      ],
    });
    expect(ok).toBe(true);
    expect(getFleetStatus('h1')).toEqual({
      mode: 'patrol', stance: 'aggressive', activity: 'patrolling', targetId: null,
      route: [[1, 2], [3, 4]],
    });
    expect(getFleetStatus('h2')).toEqual({
      mode: 'escort', stance: 'defensive', activity: 'moving', targetId: 's:9',
      orderKind: 'move', orderX: 50, orderY: 60, escortId: 'h1', squadId: 'sq-3',
    });
  });

  it('replaces: ships missing from the next message are dropped', () => {
    const row = (id: string) => encodeFleetStatusRow({ id, mode: 'defend', stance: 'defensive', activity: 'idle', targetId: null });
    ingestFleetStatus({ type: 'fleet_status', s: [row('a'), row('b')] });
    ingestFleetStatus({ type: 'fleet_status', s: [row('b')] });
    expect(getFleetStatus('a')).toBeUndefined();
    expect(getFleetStatus('b')).toBeDefined();
    ingestFleetStatus({ type: 'fleet_status', s: [] });
    expect(getFleetStatus('b')).toBeUndefined();
  });

  it('carries the appended shield % (and still reads a sender without it)', () => {
    const base = { mode: 'hunt', stance: 'aggressive', activity: 'attacking', targetId: null } as const;
    expect(ingestFleetStatus({
      type: 'fleet_status',
      s: [encodeFleetStatusRow({ id: 'w', ...base, shieldPct: 40 }), encodeFleetStatusRow({ id: 'old', ...base })],
    })).toBe(true);
    expect(getFleetStatus('w')?.shieldPct).toBe(40);
    expect(getFleetStatus('old')?.shieldPct).toBeUndefined();
  });

  it('drops an invalid message without touching the status', () => {
    const v = getFleetStatusVersion();
    expect(ingestFleetStatus({ type: 'fleet_status', s: [['x', 99]] })).toBe(false);
    expect(ingestFleetStatus(null)).toBe(false);
    expect(getFleetStatusVersion()).toBe(v);
  });
});
