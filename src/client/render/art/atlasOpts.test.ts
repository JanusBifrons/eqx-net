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

  // Phone run 2026-11-07: Chrome hides navigator.deviceMemory on a plain-http
  // page and iPhones never report it, so "unknown" is the COMMON case; it gave
  // the old 6 pages and Vega Reach's asteroids drew bare. Unknown = full budget.
  // Chrome only reports 0.25/0.5/1/2/4/8, so 4 means "4 to 8 GB".
  it('phones: by reported memory; unknown gets the full phone budget', () => {
    expect(atlasOptsFor(true).maxPages).toBe(14);
    expect(atlasOptsFor(true, 1).maxPages).toBe(4);
    expect(atlasOptsFor(true, 2).maxPages).toBe(6);
    expect(atlasOptsFor(true, 4).maxPages).toBe(10);
    expect(atlasOptsFor(true, 8).maxPages).toBe(14);
    expect(atlasOptsFor(true, 8).pageSize).toBe(2048);
  });
});
