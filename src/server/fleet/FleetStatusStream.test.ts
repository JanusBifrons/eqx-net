import { describe, it, expect } from 'vitest';
import { FleetStatusStream, FLEET_STATUS_EVERY_N_FIRES } from './FleetStatusStream.js';
import type { FleetShipStatus } from './FleetCommandSubsystem.js';
import type { WingmanBehaviour } from '../../core/ai/WingmanBehaviour.js';
import { FleetStatusMessageSchema, decodeFleetStatusRow, type FleetStatusMessage } from '../../shared-types/messages/fleetStatusMessages.js';

function status(id: string, over: Partial<FleetShipStatus> = {}): FleetShipStatus {
  return { id, mode: 'defend', stance: 'defensive', activity: 'guarding', targetId: null, order: null, squadId: null, ...over };
}

function harness(owned: Record<string, FleetShipStatus[]>, brains: Record<string, Partial<WingmanBehaviour>> = {}) {
  const sent: { sessionId: string; msg: FleetStatusMessage }[] = [];
  const sessions: [string, string][] = Object.keys(owned).map((pid) => [`sess-${pid}`, pid]);
  const stream = new FleetStatusStream({
    fleet: {
      statusFor: (pid: string) => owned[pid] ?? [],
      brainOf: (id: string) => (brains[id] as WingmanBehaviour | undefined) ?? null,
    },
    forEachSession: (cb) => { for (const [s, p] of sessions) cb(s, p); },
    hullPct: (id) => (id === 'gone' ? null : 42.4),
    send: (sessionId, msg) => sent.push({ sessionId, msg }),
  });
  return { stream, sent };
}

describe('FleetStatusStream', () => {
  it('sends on every Nth timer fire only', () => {
    const { stream, sent } = harness({ a: [status('h1')] });
    for (let i = 1; i < FLEET_STATUS_EVERY_N_FIRES; i++) stream.tick();
    expect(sent).toHaveLength(0);
    stream.tick();
    expect(sent).toHaveLength(1);
  });

  it('each owner gets only their own ships, encoded as valid tuples', () => {
    const { stream, sent } = harness({
      a: [status('h1', { order: { kind: 'move', x: 10, y: -5 }, squadId: 'sq-1' })],
      b: [status('h2', { mode: 'escort', activity: 'formingUp' })],
    }, {
      h1: { mode: 'defend', patrolRouteLength: 0, moraleOutcome: 1, escortId: null } as Partial<WingmanBehaviour>,
      h2: { mode: 'escort', patrolRouteLength: 0, moraleOutcome: null, escortId: 'a' } as Partial<WingmanBehaviour>,
    });
    stream.sendAll();
    const forA = sent.find((s) => s.sessionId === 'sess-a')!.msg;
    const forB = sent.find((s) => s.sessionId === 'sess-b')!.msg;
    expect(FleetStatusMessageSchema.safeParse(forA).success).toBe(true);
    const ra = forA.s.map(decodeFleetStatusRow);
    expect(ra).toEqual([{
      id: 'h1', mode: 'defend', stance: 'defensive', activity: 'guarding', targetId: null, hullPct: 42,
      moraleOutcome: 'fallBack', squadId: 'sq-1', orderKind: 'move', orderX: 10, orderY: -5,
    }]);
    const rb = forB.s.map(decodeFleetStatusRow);
    expect(rb.map((r) => r.id)).toEqual(['h2']);
    expect(rb[0]!.escortId).toBe('a');
  });

  it('carries the patrol route', () => {
    const route: [number, number][] = [[0, 0], [5, 6], [7, 8]];
    const { stream, sent } = harness({ a: [status('h1', { mode: 'patrol', activity: 'patrolling' })] }, {
      h1: {
        mode: 'patrol', patrolRouteLength: 3, moraleOutcome: null, escortId: null,
        patrolRouteX: (i: number) => route[i]![0], patrolRouteY: (i: number) => route[i]![1],
      } as Partial<WingmanBehaviour>,
    });
    stream.sendAll();
    expect(decodeFleetStatusRow(sent[0]!.msg.s[0]!).route).toEqual(route);
  });

  it('sends one empty list, then skips repeat empty sends until it changes', () => {
    const owned: Record<string, FleetShipStatus[]> = { a: [] };
    const { stream, sent } = harness(owned);
    stream.sendAll();
    stream.sendAll();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg.s).toEqual([]);
    owned.a = [status('h1')];
    stream.sendAll();
    expect(sent).toHaveLength(2);
    owned.a = [];
    stream.sendAll();
    stream.sendAll();
    expect(sent).toHaveLength(3); // one empty after the fleet emptied
    stream.clearSession('sess-a');
    stream.sendAll();
    expect(sent).toHaveLength(4); // a fresh session gets its empty list again
  });
});
