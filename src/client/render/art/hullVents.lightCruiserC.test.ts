/** Hull vents clear of turret rings on the light-cruiser-c: see `hullVents.test.ts`
 *  (one capital per file so the forges run on parallel workers). */
import { describe, it, expect } from 'vitest';
import { ventsTouchingRings } from './__fixtures__/hullVentsLock.js';

describe('capital hull vents stay clear of turret rings', () => {
  it('light-cruiser-c', () => {
    expect(ventsTouchingRings('light-cruiser-c')).toEqual([]);
  }, 60_000);
});
