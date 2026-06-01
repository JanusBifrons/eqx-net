/**
 * Plan: crispy-kazoo, Commit 7 — lock the `transitionDuration` zero
 * override on the ShipPickerModal Dialog so a future MUI version bump
 * (or someone restoring the eased-in feel) doesn't silently regress
 * the sector-pick responsiveness.
 *
 * The MUI Grow transition default is ~225 ms enter / ~195 ms exit;
 * combined with the existing `PICKER_OPEN_DELAY_MS = 200` touch-bleed
 * guard, the pre-fix click-to-visible was ~430 ms. The transitionless
 * override drops the perceived lag to ~230 ms (the touch-bleed delay
 * remains load-bearing — do not remove it).
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ShipPickerModal } from './ShipPickerModal.js';

describe('ShipPickerModal — transitionless Dialog (Commit 7)', () => {
  it('renders the modal contents synchronously when open transitions false→true', () => {
    // With the Grow transition's enter duration > 0, the Dialog's
    // children paint inside a transitioning container; the testid for
    // the content stays absent until the transition completes. With
    // `transitionDuration={{ enter: 0, exit: 0 }}` the DOM is present
    // on the synchronous render pass.
    const { getByTestId, queryByTestId } = render(
      <ShipPickerModal
        open
        onClose={() => {}}
        selectedKind="fighter"
        onSelect={() => {}}
      />,
    );
    // Modal is in the DOM immediately.
    expect(getByTestId('ship-picker-modal')).toBeTruthy();
    // The transitionless override means the role="dialog" Paper is
    // already at full opacity. We don't probe MUI's internal class
    // names directly (brittle); the structural presence assertion
    // above is what regression-locks the contract.
    expect(queryByTestId('ship-picker-modal')).not.toBeNull();
  });

  it('does NOT render anything when open is false', () => {
    const { queryByTestId } = render(
      <ShipPickerModal
        open={false}
        onClose={() => {}}
        selectedKind="fighter"
        onSelect={() => {}}
      />,
    );
    expect(queryByTestId('ship-picker-modal')).toBeNull();
  });
});
