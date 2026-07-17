/**
 * Campaign 6.1 — the `welcome` trust boundary drops malformed payloads
 * instead of raw-casting them into prediction anchoring (invariant #3).
 *
 * Reproduction (review C-core 3): pre-fix, `room.onMessage('welcome',
 * (msg: WelcomeMessage) => ...)` was a raw cast — ANY payload shape reached
 * `this.inputTick = msg.serverTick` / `mirror.localPlayerId = msg.playerId`
 * unchecked. These cases lock the extracted pure guard the handler now
 * routes through.
 */
import { describe, it, expect } from 'vitest';
import { parseWelcome } from './parseWelcome.js';

const valid = {
  type: 'welcome' as const,
  playerId: 'player-1',
  serverTick: 1234,
  sectorKey: 'sol-prime',
  shipInstanceId: 'ship-uuid-1',
};

describe('parseWelcome (campaign 6.1)', () => {
  it('returns the typed message for a valid payload', () => {
    const msg = parseWelcome(valid);
    expect(msg).not.toBeNull();
    expect(msg!.playerId).toBe('player-1');
    expect(msg!.serverTick).toBe(1234);
  });

  it('accepts the engineering-room shape (null sectorKey, empty shipInstanceId)', () => {
    expect(parseWelcome({ ...valid, sectorKey: null, shipInstanceId: '' })).not.toBeNull();
  });

  it('drops (null) a payload with a non-numeric serverTick', () => {
    expect(parseWelcome({ ...valid, serverTick: 'soon' })).toBeNull();
  });

  it('drops (null) a payload missing playerId', () => {
    const { playerId: _p, ...noPlayer } = valid;
    expect(parseWelcome(noPlayer)).toBeNull();
  });

  it('drops (null) garbage payloads (string / null / undefined / array)', () => {
    expect(parseWelcome('welcome')).toBeNull();
    expect(parseWelcome(null)).toBeNull();
    expect(parseWelcome(undefined)).toBeNull();
    expect(parseWelcome([])).toBeNull();
  });

  it('drops (null) a payload with unknown extra keys (strict)', () => {
    expect(parseWelcome({ ...valid, evil: 1 })).toBeNull();
  });
});
