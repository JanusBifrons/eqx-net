import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ShipPickerModal, isFreeHull } from './ShipPickerModal';

describe('ShipPickerModal — hull gate (economy v2 W5b)', () => {
  it('only starter hulls are free', () => {
    expect(isFreeHull('fighter')).toBe(true);
    expect(isFreeHull('scout')).toBe(true);
    expect(isFreeHull('gunship')).toBe(false);
  });

  it('non-starter cards are visible but locked with a hint; a locked kind cannot be spawned', () => {
    const onSelect = vi.fn();
    // The remembered last choice is a gunship — now locked, so Fighter is pre-selected.
    render(<ShipPickerModal open onClose={() => {}} selectedKind="gunship" onSelect={onSelect} />);
    const gunship = screen.getByTestId('ship-card-gunship');
    expect(gunship.getAttribute('data-locked')).toBe('1');
    expect(gunship.textContent).toContain('Buy & unpack');
    expect(screen.getByTestId('ship-card-fighter').getAttribute('data-selected')).toBe('1');
    fireEvent.click(gunship.querySelector('button')!);
    expect(gunship.getAttribute('data-selected')).toBe('0');
    fireEvent.click(screen.getByTestId('ship-picker-spawn'));
    expect(onSelect).toHaveBeenCalledWith('fighter');
  });
});
