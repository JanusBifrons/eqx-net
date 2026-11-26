import { describe, expect, it } from 'vitest';
import { STRUCTURE_KINDS_LIST, isConnectorKind } from '../structureKinds.js';

describe('isConnectorKind', () => {
  it('is true for the connector and the Large Teleporter (a plate building, base platforms slice 22)', () => {
    expect(isConnectorKind('connector')).toBe(true);
    expect(isConnectorKind('teleporter_large')).toBe(true);
  });

  it('is false for every other kind in the catalogue', () => {
    for (const k of STRUCTURE_KINDS_LIST) {
      if (k.id === 'connector' || k.id === 'teleporter_large') continue; // alien_gate included: never a connector
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
