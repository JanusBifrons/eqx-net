import { describe, it, expect } from 'vitest';
import { LINGER_BODY_PREFIX, wireShipBodyId } from './shipBodyIds.js';

describe('wireShipBodyId (RTS Part A S3)', () => {
  it('strips the server worker prefix from a parked hull body', () => {
    expect(wireShipBodyId(`${LINGER_BODY_PREFIX}abc-123`)).toBe('abc-123');
  });

  it('leaves every other body id unchanged', () => {
    expect(wireShipBodyId('player-uuid')).toBe('player-uuid');
    expect(wireShipBodyId('swarm-42')).toBe('swarm-42');
    expect(wireShipBodyId('lingerer')).toBe('lingerer');
  });
});
