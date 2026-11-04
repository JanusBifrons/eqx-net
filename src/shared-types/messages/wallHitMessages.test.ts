import { describe, it, expect } from 'vitest';
import { WallHitEventSchema } from './wallHitMessages.js';

describe('WallHitEventSchema (fence-hit fix)', () => {
  it('accepts a bolt or missile hit and rejects junk', () => {
    expect(WallHitEventSchema.safeParse({ type: 'wall_hit', x: 1, y: 2, kind: 'bolt' }).success).toBe(true);
    expect(WallHitEventSchema.safeParse({ type: 'wall_hit', x: 1, y: 2, kind: 'missile' }).success).toBe(true);
    expect(WallHitEventSchema.safeParse({ type: 'wall_hit', x: 1, y: 2, kind: 'beam' }).success).toBe(false);
    expect(WallHitEventSchema.safeParse({ type: 'wall_hit', x: Number.NaN, y: 2, kind: 'bolt' }).success).toBe(false);
  });
});
