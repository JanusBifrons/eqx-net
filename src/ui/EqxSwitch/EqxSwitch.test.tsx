import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EqxSwitch } from './EqxSwitch.js';

describe('EqxSwitch', () => {
  it('renders its label as the accessible name and forwards data-testid', () => {
    render(<EqxSwitch checked={false} onChange={() => {}} label="Full screen" data-testid="sw" />);
    expect(screen.getByRole('checkbox', { name: 'Full screen' })).toBeTruthy();
    expect(screen.getByTestId('sw').textContent).toContain('Full screen');
  });

  it('checked switches the control state', () => {
    const { rerender } = render(<EqxSwitch checked={false} onChange={() => {}} label="A" />);
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', false);
    rerender(<EqxSwitch checked onChange={() => {}} label="A" />);
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', true);
  });

  it('onChange receives the next value', () => {
    const onChange = vi.fn();
    render(<EqxSwitch checked={false} onChange={onChange} label="A" />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('disabled blocks changes', async () => {
    const onChange = vi.fn();
    render(<EqxSwitch checked={false} onChange={onChange} label="A" disabled />);
    expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByText('A'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
