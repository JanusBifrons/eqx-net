import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { StructurePlacementBanner } from './StructurePlacementBanner.js';
import { useUIStore } from '../state/store.js';
import { placementChosen, resetPlacementChosen } from '../structures/placementChosen.js';

/**
 * Smoke 2026-06-07 (capture kuytvy): on a REAL phone, Confirm placed the
 * structure ahead-of-ship, ignoring where the player positioned the ghost —
 * while the E2E (D/E in structure-placement-ghost.spec.ts) passed. Root cause:
 * the banner read the chosen point from `data-placement-world-x`, but that whole
 * dataset surface is gated behind `navigator.webdriver` (E2E-only — see
 * gameRafLoop's `writeE2E`). Playwright sets webdriver=true so the dataset
 * existed; a real player leaves it undefined so Confirm read nothing and fell
 * back to ahead-of-ship.
 *
 * This test reproduces the DEVICE condition: jsdom has no game-surface element
 * and no dataset writer, so the old (dataset-reading) banner falls back to
 * ahead-of-ship → it FAILS the first assertion. The fix routes the chosen point
 * through the `placementChosen` module singleton (populated by gameRafLoop
 * regardless of navigator.webdriver), which IS present here → it passes. This is
 * the right level: an E2E can't express "navigator.webdriver is absent" because
 * Playwright IS webdriver.
 */
const placeStructureAt = vi.fn();
const placeStructureAhead = vi.fn();
vi.mock('../structures/structurePlacementClient', () => ({
  placeStructureAt: (...a: unknown[]) => placeStructureAt(...a),
  placeStructureAhead: (...a: unknown[]) => placeStructureAhead(...a),
}));

describe('StructurePlacementBanner — Confirm reads the production channel', () => {
  beforeEach(() => {
    cleanup();
    placeStructureAt.mockClear();
    placeStructureAhead.mockClear();
    resetPlacementChosen();
    useUIStore.setState({ placementKind: 'capital' });
  });

  it('places at the pointer-chosen point from placementChosen (NOT the E2E-only dataset)', () => {
    placementChosen.worldX = 1234.5;
    placementChosen.worldY = -678.25;
    placementChosen.stuck = true;

    const { getByTestId } = render(<StructurePlacementBanner />);
    fireEvent.click(getByTestId('placement-confirm'));

    expect(placeStructureAt).toHaveBeenCalledTimes(1);
    expect(placeStructureAt).toHaveBeenCalledWith('capital', 1234.5, -678.25);
    expect(placeStructureAhead).not.toHaveBeenCalled();
  });

  it('falls back to ahead-of-ship only when the ghost was never positioned', () => {
    // placementChosen left null by resetPlacementChosen() in beforeEach.
    const { getByTestId } = render(<StructurePlacementBanner />);
    fireEvent.click(getByTestId('placement-confirm'));

    expect(placeStructureAhead).toHaveBeenCalledTimes(1);
    expect(placeStructureAhead).toHaveBeenCalledWith('capital');
    expect(placeStructureAt).not.toHaveBeenCalled();
  });
});
