import { describe, it, expect } from 'vitest';
import { AuthCodeStore, AUTH_CODE_TTL_MS } from './authCodeStore.js';

const payload = { token: 'jwt-token', user: { id: 'u1', email: 'u@test.local', displayName: null } };

describe('AuthCodeStore (S3 — one-time code exchange)', () => {
  it('round-trips a payload through issue → redeem', () => {
    const store = new AuthCodeStore();
    const code = store.issue(payload);
    expect(store.redeem(code)).toEqual(payload);
  });

  it('is single-use: a second redeem of the same code returns null', () => {
    const store = new AuthCodeStore();
    const code = store.issue(payload);
    expect(store.redeem(code)).not.toBeNull();
    expect(store.redeem(code)).toBeNull();
  });

  it('returns null for an unknown code', () => {
    const store = new AuthCodeStore();
    expect(store.redeem('never-issued')).toBeNull();
  });

  it('returns null for an expired code', () => {
    let t = 1_000_000;
    const store = new AuthCodeStore({ now: () => t });
    const code = store.issue(payload);
    t += AUTH_CODE_TTL_MS + 1;
    expect(store.redeem(code)).toBeNull();
  });

  it('issues distinct codes for repeated payloads', () => {
    const store = new AuthCodeStore();
    expect(store.issue(payload)).not.toBe(store.issue(payload));
  });
});
