/**
 * RTS slice 10 — which `startMode` a join sends. Normal galaxy play lands in
 * command view; test rooms, `?startMode=fly` and "pilot that ship" fly.
 */
import { describe, it, expect } from 'vitest';
import { StartModeSchema } from '@shared-types/messages';
import { defaultStartModeForRoom, resolveStartMode } from './startMode.js';

describe('startMode (RTS slice 10)', () => {
  it('galaxy sectors default to command; test / engineering rooms to fly', () => {
    expect(defaultStartModeForRoom('galaxy-sol-prime')).toBe('command');
    expect(defaultStartModeForRoom('galaxy-test')).toBe('fly');
    expect(defaultStartModeForRoom('test-sector')).toBe('fly');
    expect(defaultStartModeForRoom('sector')).toBe('fly');
  });

  it('?startMode= overrides the room default; junk is ignored', () => {
    expect(resolveStartMode('galaxy-sol-prime', 'fly', undefined)).toBe('fly');
    expect(resolveStartMode('galaxy-test', 'command', undefined)).toBe('command');
    expect(resolveStartMode('galaxy-sol-prime', 'warp', undefined)).toBe('command');
  });

  it('an explicit join-option override wins over the URL', () => {
    expect(resolveStartMode('galaxy-sol-prime', 'command', { shipId: 'x', startMode: 'fly' })).toBe('fly');
  });

  it('a spectator join sends none (nothing to park)', () => {
    expect(resolveStartMode('galaxy-sol-prime', null, { spectator: true })).toBeUndefined();
  });

  it('the join-option schema accepts command / fly and rejects anything else', () => {
    expect(StartModeSchema.safeParse('command').success).toBe(true);
    expect(StartModeSchema.safeParse('fly').success).toBe(true);
    expect(StartModeSchema.safeParse('pilot').success).toBe(false);
    expect(StartModeSchema.safeParse(undefined).success).toBe(false);
  });
});
