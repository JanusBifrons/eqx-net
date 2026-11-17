import { describe, expect, it } from 'vitest';
import { GalaxySnapshotResponseSchema, SectorHistoryResponseSchema } from './galaxySnapshot.js';

describe('galaxy snapshot schemas tolerate fields added later (strip, not strict)', () => {
  it('a sector with an unknown key (top level and nested) parses, the extras are dropped', () => {
    const r = GalaxySnapshotResponseSchema.safeParse({
      sectors: [
        {
          key: 'sol-prime', players: 1, enemies: 0, neutrals: 0, structures: 2,
          owner: { factionId: 'core', contested: false, futureOwnerField: 1 },
          control: {
            holderShare: 90, challenger: null, challengerShare: 0, trend: 0, threat: 0,
            flippedAtMs: null, locked: false, futureControlField: 'x',
          },
          futureSectorField: { anything: true },
        },
      ],
      futureTopField: 3,
    });
    expect(r.success).toBe(true);
    const s = r.success ? r.data.sectors[0]! : null;
    expect(s && 'futureSectorField' in s).toBe(false);
    expect(s?.control?.holderShare).toBe(90);
  });

  it('history samples tolerate an unknown key', () => {
    const r = SectorHistoryResponseSchema.safeParse({
      key: 'sol-prime', samples: [{ atMs: 1, holder: 'core', holderShare: 100, extra: 1 }], extra: 2,
    });
    expect(r.success).toBe(true);
  });
});
