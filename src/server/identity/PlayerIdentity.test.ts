import { describe, it, expect } from 'vitest';
import { isValidUUID, assignPlayerId } from './PlayerIdentity.js';

const VALID = '123e4567-e89b-12d3-a456-426614174000';

describe('isValidUUID', () => {
  it('accepts a well-formed UUID (case-insensitive)', () => {
    expect(isValidUUID(VALID)).toBe(true);
    expect(isValidUUID(VALID.toUpperCase())).toBe(true);
  });

  it('rejects malformed strings', () => {
    expect(isValidUUID('not-a-uuid')).toBe(false);
    expect(isValidUUID('123e4567e89b12d3a456426614174000')).toBe(false); // no dashes
    expect(isValidUUID('')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isValidUUID(42)).toBe(false);
    expect(isValidUUID(null)).toBe(false);
    expect(isValidUUID(undefined)).toBe(false);
    expect(isValidUUID({})).toBe(false);
  });
});

describe('assignPlayerId', () => {
  it('returns the requested id when it is a valid UUID', () => {
    expect(assignPlayerId(VALID)).toBe(VALID);
  });

  it('mints a fresh valid UUID when the requested id is invalid or absent', () => {
    const a = assignPlayerId('garbage');
    const b = assignPlayerId(null);
    expect(isValidUUID(a)).toBe(true);
    expect(isValidUUID(b)).toBe(true);
    expect(a).not.toBe(b); // distinct fresh ids
  });
});
