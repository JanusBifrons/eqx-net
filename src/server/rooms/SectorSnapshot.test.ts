import { describe, it, expect } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  SNAPSHOT_STALENESS_MS,
  parseSnapshot,
  migrateSnapshot,
  type SectorSnapshotPayload,
} from './SectorSnapshot.js';

describe('SectorSnapshot', () => {
  const validPayload: SectorSnapshotPayload = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    sectorKey: 'sol-prime',
    savedAtMs: 1_700_000_000_000,
    swarm: [
      { entityId: 'drone-0', kind: 1, x: 100, y: 200, health: 25 },
      { entityId: 'asteroid-0', kind: 0, x: -50, y: 80, health: 0 },
    ],
  };

  describe('parseSnapshot', () => {
    it('round-trips a valid v1 payload', () => {
      const json = JSON.stringify(validPayload);
      const out = parseSnapshot(JSON.parse(json));
      expect(out).toEqual(validPayload);
    });

    it('throws on a non-object', () => {
      expect(() => parseSnapshot('nope')).toThrow();
      expect(() => parseSnapshot(null)).toThrow();
      expect(() => parseSnapshot(42)).toThrow();
    });

    it('throws on missing schemaVersion', () => {
      expect(() => parseSnapshot({ sectorKey: 'x', savedAtMs: 0, swarm: [] })).toThrow(/schemaVersion/);
    });

    it('routes a non-current schema version through migrateSnapshot (which throws by default)', () => {
      const wrongVersion = { ...validPayload, schemaVersion: 999 };
      expect(() => parseSnapshot(wrongVersion)).toThrow(/No migration/);
    });
  });

  describe('migrateSnapshot', () => {
    it('throws by default — Phase 8 strategy is tear-down-on-change', () => {
      expect(() => migrateSnapshot({}, 0, 1)).toThrow(/No migration from sector-snapshot schema v0 to v1/);
    });
  });

  it('SNAPSHOT_STALENESS_MS is 24 h', () => {
    expect(SNAPSHOT_STALENESS_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('CURRENT_SCHEMA_VERSION is a positive integer', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(CURRENT_SCHEMA_VERSION)).toBe(true);
  });

  // ── Phase 4 WS-0 — structures[].level + schema 5→6 ─────────────────
  describe('Phase 4 WS-0 — structures[].level + schema bump', () => {
    it('CURRENT_SCHEMA_VERSION bumped to 6', () => {
      expect(CURRENT_SCHEMA_VERSION).toBe(6);
    });

    it('round-trips a payload carrying structures[].level', () => {
      const payload: SectorSnapshotPayload = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        sectorKey: 'sol-prime',
        savedAtMs: 1_700_000_000_000,
        swarm: [],
        structures: [
          {
            entityId: 'pstruct-1',
            owner: 'p1',
            kind: 'capital',
            x: 10,
            y: 20,
            health: 500,
            isConstructed: true,
            constructionProgress: 0,
            minerals: 0,
            storedPower: 0,
            level: 3,
          },
        ],
      };
      const out = parseSnapshot(JSON.parse(JSON.stringify(payload)));
      expect(out.structures?.[0]?.level).toBe(3);
    });

    it('migrateSnapshot(v5 → v6) drops every prior snapshot (tear-down-on-change)', () => {
      const v5 = {
        schemaVersion: 5,
        sectorKey: 'sol-prime',
        savedAtMs: 0,
        swarm: [],
      };
      expect(() => parseSnapshot(v5)).toThrow(/No migration from sector-snapshot schema v5 to v6/);
    });
  });
});
