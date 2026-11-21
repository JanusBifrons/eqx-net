/**
 * RTS command layer slice 6a — fleet command senders post the right
 * type + payload, and every payload passes its server schema (#15).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sendDisbandSquad,
  sendFleetOrder,
  sendFleetSpeed,
  sendFormSquad,
  sendSetMode,
  sendSetStance,
} from './shipActionsClient.js';
import { ClientMessageSchema } from '../../shared-types/messages.js';
import { HELM_SPEED_FRACTION } from '../../core/helm/helm.js';

const send = vi.fn();
let hasRoom = true;
vi.mock('../net/clientSingleton.js', () => ({
  getGameClient: () =>
    hasRoom
      ? ({
          sendFleetCommand: (msg: { type: string }) => {
            send(msg.type, msg);
            return true;
          },
        } as unknown)
      : null,
}));

function lastSent(): { type: string; payload: unknown } {
  const [type, payload] = send.mock.calls[send.mock.calls.length - 1] as [string, unknown];
  expect(ClientMessageSchema.safeParse(payload).success).toBe(true);
  return { type, payload };
}

describe('fleet command senders (RTS slice 6a)', () => {
  beforeEach(() => {
    send.mockClear();
    hasRoom = true;
  });

  it('sendFleetOrder move/attack/stop', () => {
    expect(sendFleetOrder(['a'], { kind: 'move', x: 1, y: 2 })).toBe(true);
    expect(lastSent()).toEqual({ type: 'fleet_order', payload: { type: 'fleet_order', shipIds: ['a'], kind: 'move', x: 1, y: 2 } });
    sendFleetOrder(['a'], { kind: 'attack', targetId: 't' });
    expect(lastSent().payload).toEqual({ type: 'fleet_order', shipIds: ['a'], kind: 'attack', targetId: 't' });
    sendFleetOrder(['a'], { kind: 'stop' });
    expect(lastSent().payload).toEqual({ type: 'fleet_order', shipIds: ['a'], kind: 'stop' });
  });

  it('Command speed parity (#15): every telegraph step crosses the wire as its shared fraction', () => {
    for (const step of [0, 1, 2, 3] as const) {
      const fraction = HELM_SPEED_FRACTION[step]!;
      sendFleetOrder(['a'], { kind: 'move', x: 1, y: 2, speed: fraction });
      const move = ClientMessageSchema.parse(lastSent().payload) as { kind: string; speed?: number };
      expect(move).toMatchObject({ kind: 'move', speed: fraction });
      expect(sendFleetSpeed(['a', 'b'], fraction)).toBe(true);
      const pace = ClientMessageSchema.parse(lastSent().payload) as { kind: string; speed?: number };
      expect(pace).toEqual({ type: 'fleet_order', shipIds: ['a', 'b'], kind: 'speed', speed: fraction });
    }
    expect(HELM_SPEED_FRACTION[0]).toBe(0);
    expect(HELM_SPEED_FRACTION[3]).toBe(1);
  });

  it('the server schema rejects a bad speed', () => {
    const base = { type: 'fleet_order', shipIds: ['a'] };
    for (const speed of [-0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(ClientMessageSchema.safeParse({ ...base, kind: 'speed', speed }).success, String(speed)).toBe(false);
      expect(ClientMessageSchema.safeParse({ ...base, kind: 'move', x: 0, y: 0, speed }).success, String(speed)).toBe(false);
    }
    expect(ClientMessageSchema.safeParse({ ...base, kind: 'speed' }).success, 'speed without speed').toBe(false);
    expect(ClientMessageSchema.safeParse({ ...base, kind: 'move', x: 0, y: 0 }).success, 'old client').toBe(true);
  });

  it('sendSetMode includes only given params', () => {
    sendSetMode(['a'], 'defend');
    expect(lastSent()).toEqual({ type: 'set_mode', payload: { type: 'set_mode', shipIds: ['a'], mode: 'defend' } });
    sendSetMode(['a'], 'patrol', { route: [[0, 0], [10, 10]], guardRadius: 50, escortId: 'e' });
    expect(lastSent().payload).toEqual({
      type: 'set_mode', shipIds: ['a'], mode: 'patrol', route: [[0, 0], [10, 10]], guardRadius: 50, escortId: 'e',
    });
  });

  it('sendSetStance / sendFormSquad / sendDisbandSquad', () => {
    sendSetStance(['a'], 'holdFire');
    expect(lastSent()).toEqual({ type: 'set_stance', payload: { type: 'set_stance', shipIds: ['a'], stance: 'holdFire' } });
    sendFormSquad(['a', 'b']);
    expect(lastSent()).toEqual({ type: 'form_squad', payload: { type: 'form_squad', shipIds: ['a', 'b'] } });
    sendDisbandSquad('q1');
    expect(lastSent()).toEqual({ type: 'disband_squad', payload: { type: 'disband_squad', squadId: 'q1' } });
  });

  it('returns false with no game client', () => {
    hasRoom = false;
    expect(sendFormSquad(['a', 'b'])).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
