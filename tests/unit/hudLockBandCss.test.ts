import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Showcase review 2026-11-10 (`pack-battle`, hud 'minimal'): a red
 * "24 SHIPS HAVE YOU LOCKED" banner drew over the ships. The fire-control lock
 * banner (`LockStatusBand`, testid `fc-lock-band`) is HUD and shows only with
 * the full HUD, the same rule as the world lock marks
 * (`cinematic/hudMode.ts` `lockOverlaysVisible`).
 */
describe('index.html — lock banner follows the HUD mode', () => {
  const html = readFileSync(fileURLToPath(new URL('../../src/client/index.html', import.meta.url)), 'utf8');

  it('is hidden in clean / minimal / none', () => {
    for (const m of ['clean', 'minimal', 'none']) {
      expect(html).toContain(`html.eqx-hud-${m} [data-testid="fc-lock-band"]`);
    }
  });

  it('is never hidden in full (the fc-* shots film it)', () => {
    expect(html).not.toContain('html.eqx-hud-full [data-testid="fc-lock-band"]');
  });
});
