import { describe, it, expect } from 'vitest';
import { createOAuthState, verifyOAuthState, OAUTH_STATE_TTL_MS } from './oauthState.js';

const SECRET = 'test-secret';

describe('oauthState (S4 — stateless HMAC CSRF)', () => {
  it('round-trips a freshly-minted state', () => {
    const t0 = 1_000_000_000;
    const state = createOAuthState(SECRET, t0);
    expect(verifyOAuthState(state, SECRET, t0 + 1000)).toBe(true);
  });

  it('rejects a tampered payload (signature mismatch)', () => {
    const t0 = 1_000_000_000;
    const state = createOAuthState(SECRET, t0);
    const tampered = state.replace(/^[^.]+/, 'forged-nonce');
    expect(verifyOAuthState(tampered, SECRET, t0)).toBe(false);
  });

  it('rejects a state signed with a different secret', () => {
    const t0 = 1_000_000_000;
    const state = createOAuthState('other-secret', t0);
    expect(verifyOAuthState(state, SECRET, t0)).toBe(false);
  });

  it('rejects an expired state (past the TTL)', () => {
    const t0 = 1_000_000_000;
    const state = createOAuthState(SECRET, t0);
    expect(verifyOAuthState(state, SECRET, t0 + OAUTH_STATE_TTL_MS + 1)).toBe(false);
  });

  it('rejects a malformed (non-3-part) token', () => {
    expect(verifyOAuthState('garbage', SECRET)).toBe(false);
    expect(verifyOAuthState('only.two', SECRET)).toBe(false);
  });

  it('rejects an implausibly future-dated token', () => {
    const t0 = 1_000_000_000;
    const state = createOAuthState(SECRET, t0 + 10_000_000);
    expect(verifyOAuthState(state, SECRET, t0)).toBe(false);
  });
});
