/**
 * Atlas budget. Adding art re-uploads its whole page (and its mips), so pages
 * stay 2048² (a 4096² page cost ~0.4 s on integrated graphics when a new
 * sector's art landed mid-trip). Phones size the budget by the memory they
 * report (a fixed 6 pages left base-heavy sectors drawing bare art).
 */
import { describe, it, expect } from 'vitest';
import { atlasOptsFor } from './ArtService.js';

describe('atlas budget', () => {
  it('desktop: 2048² pages, 64M texels', () => {
    const d = atlasOptsFor(false);
    expect(d.pageSize).toBe(2048);
    expect((d.pageSize ?? 0) ** 2 * (d.maxPages ?? 0)).toBe(4096 * 4096 * 4);
  });

  it('phones: by reported memory; unknown keeps the old 6 pages', () => {
    expect(atlasOptsFor(true).maxPages).toBe(6);
    expect(atlasOptsFor(true, 2).maxPages).toBe(4);
    expect(atlasOptsFor(true, 4).maxPages).toBe(6);
    expect(atlasOptsFor(true, 6).maxPages).toBe(10);
    expect(atlasOptsFor(true, 8).maxPages).toBe(14);
    expect(atlasOptsFor(true, 8).pageSize).toBe(2048);
  });
});
