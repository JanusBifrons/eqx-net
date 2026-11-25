import { describe, expect, it } from 'vitest';
import { STRUCTURE_KINDS_LIST, isConnectorKind } from '../structureKinds.js';

describe('isConnectorKind', () => {
  it('is true for the connector', () => {
    expect(isConnectorKind('connector')).toBe(true);
  });

  it('is false for every other kind in the catalogue', () => {
    for (const k of STRUCTURE_KINDS_LIST) {
      if (k.id === 'connector') continue;
      expect(isConnectorKind(k.id), k.id).toBe(false);
    }
  });

  it('is false for missing or unknown ids', () => {
    expect(isConnectorKind(undefined)).toBe(false);
    expect(isConnectorKind(null)).toBe(false);
    expect(isConnectorKind('')).toBe(false);
    expect(isConnectorKind('not_a_kind')).toBe(false);
  });
});
