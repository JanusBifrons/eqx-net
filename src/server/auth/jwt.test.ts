import { describe, it, expect } from 'vitest';
import { resolveJwtSecret, signToken, verifyToken } from './jwt.js';

const PLACEHOLDER = 'dev-secret-change-in-production';

describe('resolveJwtSecret (fail-closed in production, S9)', () => {
  it('falls back to the placeholder in non-production when unset', () => {
    expect(resolveJwtSecret({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(PLACEHOLDER);
  });

  it('uses a configured secret in non-production', () => {
    expect(
      resolveJwtSecret({ NODE_ENV: 'development', JWT_SECRET: 'local' } as NodeJS.ProcessEnv),
    ).toBe('local');
  });

  it('throws in production when JWT_SECRET is unset', () => {
    expect(() => resolveJwtSecret({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      /JWT_SECRET must be set/,
    );
  });

  it('throws in production when JWT_SECRET is the literal placeholder', () => {
    expect(() =>
      resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: PLACEHOLDER } as NodeJS.ProcessEnv),
    ).toThrow(/forgeable session secret/);
  });

  it('accepts a real secret in production', () => {
    expect(
      resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'a-real-strong-secret' } as NodeJS.ProcessEnv),
    ).toBe('a-real-strong-secret');
  });
});

describe('signToken / verifyToken round-trip', () => {
  it('signs a token that verifies back to the same subject', async () => {
    const token = await signToken('user-123');
    expect(typeof token).toBe('string');
    expect(await verifyToken(token)).toBe('user-123');
  });

  it('returns null for a garbage token', async () => {
    expect(await verifyToken('not.a.jwt')).toBeNull();
  });

  it('returns null for a token signed with a different secret', async () => {
    // A token shaped like ours but signed elsewhere must not verify.
    const forged =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJoYWNrZXIifQ.' +
      'ZmFrZS1zaWduYXR1cmUtdGhhdC13aWxsLW5vdC12ZXJpZnk';
    expect(await verifyToken(forged)).toBeNull();
  });
});
