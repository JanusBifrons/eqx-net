import { describe, it, expect } from 'vitest';
import { isLivingWorldDisabled } from './LivingWorldDirector.js';

/**
 * Ops kill-switch contract (2026-06-07). `EQX_DISABLE_LIVING_WORLD` lets a
 * playtest host disarm the hunter bots so building gameplay is peaceful. The
 * boot site (`src/server/index.ts`) skips constructing + starting the director
 * when this returns true. Locking the accepted values here keeps the contract
 * explicit — only `1` / `true` disarm; everything else (unset, `0`, `false`,
 * typos) leaves the living world ARMED, so a stray env var can't silently kill
 * the bots in production.
 */
describe('isLivingWorldDisabled', () => {
  it('disarms only for the explicit truthy tokens "1" and "true"', () => {
    expect(isLivingWorldDisabled({ EQX_DISABLE_LIVING_WORLD: '1' })).toBe(true);
    expect(isLivingWorldDisabled({ EQX_DISABLE_LIVING_WORLD: 'true' })).toBe(true);
  });

  it('stays ARMED for unset / falsey / unexpected values', () => {
    expect(isLivingWorldDisabled({})).toBe(false);
    expect(isLivingWorldDisabled({ EQX_DISABLE_LIVING_WORLD: undefined })).toBe(false);
    expect(isLivingWorldDisabled({ EQX_DISABLE_LIVING_WORLD: '0' })).toBe(false);
    expect(isLivingWorldDisabled({ EQX_DISABLE_LIVING_WORLD: 'false' })).toBe(false);
    expect(isLivingWorldDisabled({ EQX_DISABLE_LIVING_WORLD: 'yes' })).toBe(false);
    expect(isLivingWorldDisabled({ EQX_DISABLE_LIVING_WORLD: 'TRUE' })).toBe(false);
  });
});
