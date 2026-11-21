/**
 * `sendSetShields` passes the server's strict `SetShieldsSchema` (client →
 * server wire parity, like `tradeClientWireParity.test.ts`).
 */
import { describe, it, expect, vi } from 'vitest';
import { SetShieldsSchema } from '../../shared-types/messages.js';

const sent: Array<{ type: string; msg: unknown }> = [];
let room: { send: (type: string, msg: unknown) => void } | null = { send: (type, msg) => { sent.push({ type, msg }); } };
vi.mock('./clientSingleton.js', () => ({ getGameClient: () => ({ getRoom: () => room }) }));

import { sendSetShields } from './shieldClient.js';

describe('sendSetShields', () => {
  it('sends set_shields that the server schema accepts, both ways', () => {
    expect(sendSetShields(false)).toBe(true);
    expect(sendSetShields(true)).toBe(true);
    expect(sent.map((s) => s.type)).toEqual(['set_shields', 'set_shields']);
    for (const s of sent) expect(SetShieldsSchema.safeParse(s.msg).success).toBe(true);
    expect(sent.map((s) => (s.msg as { up: boolean }).up)).toEqual([false, true]);
  });

  it('is a no-op without a live room', () => {
    room = null;
    expect(sendSetShields(false)).toBe(false);
  });
});
