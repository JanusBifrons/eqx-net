/**
 * Adding art re-uploads its whole atlas page (and its mips), so page size is a
 * stall size: a 4096² page cost ~0.4 s on integrated graphics when a new
 * sector's art landed mid-trip (Phase 4 travel state). Pages stay at 2048² on
 * every device; the desktop budget is unchanged (64M texels).
 */
import { describe, it, expect } from 'vitest';
import { atlasOptsFor } from './ArtService.js';

describe('atlas pages are small enough to upload without a visible stall', () => {
  it('2048² pages on desktop and touch, desktop budget kept at 64M texels', () => {
    const d = atlasOptsFor(false), t = atlasOptsFor(true);
    expect(d.pageSize).toBe(2048);
    expect(t.pageSize).toBe(2048);
    expect((d.pageSize ?? 0) ** 2 * (d.maxPages ?? 0)).toBe(4096 * 4096 * 4);
  });
});
