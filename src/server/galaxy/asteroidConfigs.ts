/**
 * Server-side asteroid layouts keyed by `AsteroidConfigKey`. Kept in the
 * server zone so `src/core/galaxy/galaxy.ts` stays free of server-only
 * constants; the galaxy module references layouts by string key only.
 *
 * Phase 8 ships three keys:
 *   - 'dense':   asteroid-rich; ~8 rocks scattered in a 600u radius with
 *                varied sizes (radii 18–50) so silhouettes read as different.
 *   - 'sparse':  ~4 rocks at greater distances.
 *   - 'none':    no asteroids (drone-dominated open void sectors).
 *
 * Mass is omitted per-spec — `SwarmSpawner.spawnOne` applies
 * `ASTEROID_DEFAULT_MASS` (very heavy) so collisions don't shove rocks around.
 *
 * Layouts are deliberately positioned away from the centre (+/- ~200u origin
 * is clear) so a transit hop preserving (x, y) does not slam the player into
 * a rock on arrival. See docs/features/phase-8-galaxy-and-transit.md.
 */
import type { AsteroidSpec } from '../spawn/SwarmSpawner.js';
import type { AsteroidConfigKey } from '../../core/galaxy/galaxy.js';

const DENSE: ReadonlyArray<AsteroidSpec> = [
  { id: 'asteroid-0', x:  400, y:    0, vx: 0,    vy: 0,    radius: 18 },
  { id: 'asteroid-1', x: -380, y:  240, vx: 0.3,  vy: -0.2, radius: 22 },
  { id: 'asteroid-2', x:  360, y: -440, vx: 0,    vy: 0,    radius: 50 },
  { id: 'asteroid-3', x: -560, y: -180, vx: -0.2, vy: 0.1,  radius: 28 },
  { id: 'asteroid-4', x:  540, y:  500, vx: 0.1,  vy: 0,    radius: 36 },
  { id: 'asteroid-5', x: -260, y:  580, vx: 0,    vy: -0.3, radius: 32 },
  { id: 'asteroid-6', x:  260, y:  220, vx: 0.05, vy: 0,    radius: 40 },
  { id: 'asteroid-7', x: -440, y:  -60, vx: 0,    vy: 0.05, radius: 46 },
];

const SPARSE: ReadonlyArray<AsteroidSpec> = [
  { id: 'asteroid-0', x:  600, y:  300, vx: 0,    vy: 0,    radius: 28 },
  { id: 'asteroid-1', x: -640, y: -260, vx: 0.2,  vy: 0,    radius: 22 },
  { id: 'asteroid-2', x:  120, y: -700, vx: 0,    vy: 0.15, radius: 42 },
  { id: 'asteroid-3', x: -200, y:  720, vx: 0,    vy: 0,    radius: 50 },
];

const NONE: ReadonlyArray<AsteroidSpec> = [];

export const ASTEROID_CONFIGS: Record<AsteroidConfigKey, ReadonlyArray<AsteroidSpec>> = {
  dense:  DENSE,
  sparse: SPARSE,
  none:   NONE,
};
