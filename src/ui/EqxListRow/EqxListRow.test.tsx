import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EqxListRow } from './EqxListRow.js';

describe('EqxListRow', () => {
  it('a plain row: primary, secondary and side text, no button', () => {
    render(<EqxListRow primary="Trade station" secondary="Neutral" side="3.1 km" data-testid="r" />);
    const row = screen.getByTestId('r');
    expect(row).toHaveTextContent('Trade station');
    expect(row).toHaveTextContent('Neutral');
    expect(row).toHaveTextContent('3.1 km');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('onOpen makes the row a drill-down button named by primary, with a chevron', () => {
    const onOpen = vi.fn();
    render(<EqxListRow primary="Offers" side="4" onOpen={onOpen} data-testid="r" />);
    const btn = screen.getByRole('button', { name: 'Offers' });
    expect(btn).toBe(screen.getByTestId('r'));
    expect(btn).toHaveTextContent('›');
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('the icon is decorative (not part of the name)', () => {
    render(<EqxListRow primary="Deals" icon={<svg data-testid="ic" />} onOpen={() => {}} />);
    expect(screen.getByTestId('ic').parentElement?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('button', { name: 'Deals' })).toBeTruthy();
  });
});
