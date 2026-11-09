/**
 * exp/fire-control — every fire-control message the client sends passes the
 * server's strict schema (#3). Shapes are copied from ColyseusClient's
 * `room.send` calls (the strict schemas need the `type` the client adds).
 */
import { describe, it, expect } from 'vitest';
import {
  ClientMessageSchema,
  LockCancelSchema,
  LockRequestSchema,
  LockTrackSchema,
  SetGroupModeSchema,
} from '../../src/shared-types/messages.js';

describe('fire-control client → server wire parity', () => {
  it('lock_request', () => {
    const m = { type: 'lock_request', groupId: 'fore', target: 's:12' };
    expect(LockRequestSchema.safeParse(m).success).toBe(true);
    expect(ClientMessageSchema.safeParse(m).success).toBe(true);
  });
  it('lock_track: a target, and null (let go)', () => {
    for (const target of ['s:12', 'p:abc-123', null]) {
      const m = { type: 'lock_track', groupId: 'aft', target };
      expect(LockTrackSchema.safeParse(m).success).toBe(true);
      expect(ClientMessageSchema.safeParse(m).success).toBe(true);
    }
    expect(LockTrackSchema.safeParse({ type: 'lock_track', groupId: 'aft', target: 'x:1' }).success).toBe(false);
  });
  it('lock_cancel: one target, or the whole group', () => {
    expect(LockCancelSchema.safeParse({ type: 'lock_cancel', groupId: 'fore', target: 's:3' }).success).toBe(true);
    expect(LockCancelSchema.safeParse({ type: 'lock_cancel', groupId: 'fore' }).success).toBe(true);
  });
  it('set_group_mode', () => {
    expect(SetGroupModeSchema.safeParse({ type: 'set_group_mode', groupId: 'fore', mode: 'manual' }).success).toBe(true);
  });
});
