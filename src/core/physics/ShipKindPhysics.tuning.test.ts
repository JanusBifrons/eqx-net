import { describe, it, expect } from 'vitest';
import { PhysicsWorld } from './World.js';
import {
  SHIP_KINDS,
  SHIP_KIND_CATALOGUE_VERSION,
} from '../../shared-types/shipKinds.js';

/**
 * ABSOLUTE-VALUE regression lock for the 2026-05-18 "slow down gameplay" tune
 * (plan: i-d-like-you-to-silly-penguin — 0.5× speed / +50% hull / 10× warp).
 *
 * `ShipKindPhysics.test.ts` only asserts *ordering* and derives its `expected`
 * speed FROM the catalogue, so it would NOT catch a revert, a typo, or a
 * forgotten kind (the wrong number flows into both sides of its own check).
 * This file pins the post-tune numbers as **hardcoded literals** so any drift
 * back toward the old fast/fragile values fails loudly before merge.
 *
 * Cruise terminal (no boost, below the maxSpeed clamp for every kind) is the
 * exact fixed point of the per-tick recurrence
 *   v* = thrustImpulse / (1 - e^(-linearDamping / 60))
 * which the sibling test already validates to <5% against the live sim. We
 * assert each kind's measured cruise within 6% of the literal expected value;
 * the pre-tune thrust was exactly 2× these, so a revert misses by ~100% and
 * trips the bound immediately.
 */

const EXPECTED = {
  scout: { cruise: 361, maxHealth: 90 },
  fighter: { cruise: 401, maxHealth: 150 },
  heavy: { cruise: 451, maxHealth: 270 },
  interceptor: { cruise: 376, maxHealth: 120 },
  gunship: { cruise: 421, maxHealth: 210 },
} as const;

async function measureCruise(kindKey: keyof typeof EXPECTED): Promise<number> {
  const w = await PhysicsWorld.create();
  w.spawnShip('t', 0, 0, kindKey);
  // 1500 ticks (25 s) — ≥5 e-folds even for Heavy's 5 s time constant
  // (linearDamping 0.2), so every kind is >99% of terminal. No boost so the
  // cruise number is clamp-free (all new maxSpeed values exceed cruise).
  for (let i = 0; i < 1500; i++) {
    w.applyInput('t', { thrust: true, turnLeft: false, turnRight: false, boost: false });
    w.tick(1 / 60);
  }
  const s = w.getShipState('t')!;
  const speed = Math.hypot(s.vx, s.vy);
  w.dispose();
  return speed;
}

describe('ship-kind tuning lock (2026-05-18 slow-down pass)', () => {
  it('catalogue version was bumped to 4', () => {
    expect(SHIP_KIND_CATALOGUE_VERSION).toBe(4);
  });

  for (const kindKey of Object.keys(EXPECTED) as (keyof typeof EXPECTED)[]) {
    const exp = EXPECTED[kindKey];

    it(`${kindKey}: cruise terminal ≈ ${exp.cruise} u/s (halved)`, async () => {
      const measured = await measureCruise(kindKey);
      expect(Math.abs(measured - exp.cruise) / exp.cruise).toBeLessThan(0.06);
      // Hard ceiling well below the pre-tune cruise (~2×) so a partial revert
      // (e.g. only thrust restored) still fails here.
      expect(measured).toBeLessThan(exp.cruise * 1.3);
    });

    it(`${kindKey}: hull +50% with shield mirror and time-preserving regen`, () => {
      const k = SHIP_KINDS[kindKey];
      expect(k.maxHealth).toBe(exp.maxHealth);
      // Shield mirrors hull (catalogue contract) ...
      expect(k.shieldMax).toBe(exp.maxHealth);
      // ... and regen rate scaled with it so full-shield regen TIME is held
      // constant at ~2 s (maxHealth / 120 per tick → 120 ticks to full).
      expect(k.shieldRegenRate).toBeCloseTo(exp.maxHealth / 120, 10);
      expect(k.shieldRegenDelayTicks).toBe(300); // delay unchanged
    });
  }
});
