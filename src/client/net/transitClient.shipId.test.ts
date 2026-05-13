/**
 * Phase 5 — `engageTransit` extended with optional `shipId` for in-game
 * roster switching. The wire-shape carries shipId only when set; legacy
 * callers (PC keyboard path, pre-Phase-5 E2E) stay bit-for-bit compatible.
 *
 * Tests fake the Colyseus `Room` with a `.send` spy. They do not need the
 * full Room API — `engageTransit` only calls `.send(channel, msg)`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Room } from 'colyseus.js';
import { engageTransit, cancelTransit } from './transitClient.js';

interface SentMessage {
  channel: string;
  msg: unknown;
}

function makeFakeRoom(): { room: Room; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  const send = vi.fn((channel: string, msg: unknown): void => {
    sent.push({ channel, msg });
  });
  // We only need a `.send` method to test engageTransit; cast the partial
  // through unknown so TypeScript doesn't require us to stub the rest of
  // the Room API surface.
  return { room: { send } as unknown as Room, sent };
}

describe('engageTransit — wire shape', () => {
  it('sends bare engage_transit when no arrival or shipId is given', () => {
    const { room, sent } = makeFakeRoom();
    engageTransit(room, 'orion-belt');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.channel).toBe('engage_transit');
    expect(sent[0]!.msg).toEqual({
      type: 'engage_transit',
      targetSectorKey: 'orion-belt',
    });
  });

  it('sends engage_transit with arrival when arrival is given', () => {
    const { room, sent } = makeFakeRoom();
    engageTransit(room, 'orion-belt', { x: 100, y: -200 });
    expect(sent[0]!.msg).toEqual({
      type: 'engage_transit',
      targetSectorKey: 'orion-belt',
      arrival: { x: 100, y: -200 },
    });
  });

  it('Phase 5 — sends engage_transit with shipId when shipId is given (no arrival)', () => {
    const { room, sent } = makeFakeRoom();
    engageTransit(room, 'orion-belt', undefined, 'ship-uuid-abc');
    expect(sent[0]!.msg).toEqual({
      type: 'engage_transit',
      targetSectorKey: 'orion-belt',
      shipId: 'ship-uuid-abc',
    });
  });

  it('Phase 5 — sends both arrival and shipId together when both are given', () => {
    const { room, sent } = makeFakeRoom();
    engageTransit(room, 'orion-belt', { x: 100, y: -200 }, 'ship-uuid-abc');
    expect(sent[0]!.msg).toEqual({
      type: 'engage_transit',
      targetSectorKey: 'orion-belt',
      arrival: { x: 100, y: -200 },
      shipId: 'ship-uuid-abc',
    });
  });

  it('Phase 5 — omits shipId from the wire when shipId is undefined (regression: legacy callers)', () => {
    const { room, sent } = makeFakeRoom();
    engageTransit(room, 'orion-belt', undefined, undefined);
    const msg = sent[0]!.msg as Record<string, unknown>;
    expect(msg).not.toHaveProperty('shipId');
  });

  it('Phase 5 — omits arrival from the wire when arrival is undefined but shipId is given', () => {
    const { room, sent } = makeFakeRoom();
    engageTransit(room, 'orion-belt', undefined, 'ship-uuid-abc');
    const msg = sent[0]!.msg as Record<string, unknown>;
    expect(msg).not.toHaveProperty('arrival');
    expect(msg).toHaveProperty('shipId', 'ship-uuid-abc');
  });
});

describe('cancelTransit (regression)', () => {
  it('sends a cancel_transit message', () => {
    const { room, sent } = makeFakeRoom();
    cancelTransit(room);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.channel).toBe('cancel_transit');
    expect(sent[0]!.msg).toEqual({ type: 'cancel_transit' });
  });
});
