/**
 * Server-side asteroid layouts keyed by `AsteroidConfigKey`. Kept in the
 * server zone so `src/core/galaxy/galaxy.ts` stays free of server-only
 * constants; the galaxy module references layouts by string key only.
 *
 * Phase 8 ships three keys:
 *   - 'dense':   asteroid-rich; ~6 rocks scattered in a 600u radius.
 *   - 'sparse':  ~3 rocks at greater distances.
 *   - 'none':    no asteroids (drone-dominated open void sectors).
 *
 * Layouts are deliberately positioned away from the centre (+/- ~200u origin
 * is clear) so a transit hop preserving (x, y) does not slam the player into
 * a rock on arrival. See docs/features/phase-8-galaxy-and-transit.md.
 */
import type { AsteroidSpec } from '../spawn/SwarmSpawner.js';
import type { AsteroidConfigKey } from '../../core/galaxy/galaxy.js';

const DENSE: ReadonlyArray<AsteroidSpec> = [
  { id: 'asteroid-0', x:  400, y:    0, vx: 0,    vy: 0,    radius: 32, mass: 5 },
  { id: 'asteroid-1', x: -380, y:  240, vx: 0.3,  vy: -0.2, radius: 24, mass: 3 },
  { id: 'asteroid-2', x:  360, y: -440, vx: 0,    vy: 0,    radius: 40, mass: 7 },
  { id: 'asteroid-3', x: -560, y: -180, vx: -0.2, vy: 0.1,  radius: 28, mass: 4 },
  { id: 'asteroid-4', x:  540, y:  500, vx: 0.1,  vy: 0,    radius: 36, mass: 6 },
  { id: 'asteroid-5', x: -260, y:  580, vx: 0,    vy: -0.3, radius: 20, mass: 2 },
];

const SPARSE: ReadonlyArray<AsteroidSpec> = [
  { id: 'asteroid-0', x:  600, y:  300, vx: 0,    vy: 0,    radius: 32, mass: 5 },
  { id: 'asteroid-1', x: -640, y: -260, vx: 0.2,  vy: 0,    radius: 24, mass: 3 },
  { id: 'asteroid-2', x:  120, y: -700, vx: 0,    vy: 0.15, radius: 36, mass: 6 },
];

const NONE: ReadonlyArray<AsteroidSpec> = [];

export const ASTEROID_CONFIGS: Record<AsteroidConfigKey, ReadonlyArray<AsteroidSpec>> = {
  dense:  DENSE,
  sparse: SPARSE,
  none:   NONE,
};
