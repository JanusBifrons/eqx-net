import { describe, it, expect, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { PlacementFenceHint } from './PlacementFenceHint.js';
import { useUIStore } from '../state/store.js';

/**
 * The turret-vs-fence placement hint (a fence blocks its owner's own fire,
 * user ruling 2026-11-02). Mounted only while a shot-firing kind is placed,
 * HIDDEN until gameRafLoop finds a wall in range (turretFireCrossesWall, unit-
 * locked in fenceFireHint.test.ts); works on desktop and touch alike.
 */
describe('PlacementFenceHint', () => {
  beforeEach(() => cleanup());

  it('mounts hidden while placing a turret', () => {
    useUIStore.setState({ placementKind: 'turret' });
    const { getByTestId } = render(<PlacementFenceHint />);
    expect(getByTestId('placement-fence-hint').hidden).toBe(true);
  });

  it('is absent for kinds that fire no shots, and outside placement', () => {
    useUIStore.setState({ placementKind: 'solar' });
    expect(render(<PlacementFenceHint />).queryByTestId('placement-fence-hint')).toBeNull();
    cleanup();
    useUIStore.setState({ placementKind: null });
    expect(render(<PlacementFenceHint />).queryByTestId('placement-fence-hint')).toBeNull();
  });
});
