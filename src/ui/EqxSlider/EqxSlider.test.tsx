import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EqxSlider } from './EqxSlider.js';

describe('EqxSlider', () => {
  it('renders with its label as the accessible name and forwards data-testid', () => {
    render(<EqxSlider min={0} max={10} value={4} onChange={() => {}} label="Throttle" data-testid="sl" />);
    const thumb = screen.getByRole('slider', { name: 'Throttle' });
    expect(thumb.getAttribute('aria-valuenow')).toBe('4');
    expect(thumb.getAttribute('aria-valuemin')).toBe('0');
    expect(thumb.getAttribute('aria-valuemax')).toBe('10');
    expect(screen.getByTestId('sl').contains(thumb)).toBe(true);
  });

  it('keyboard moves by step and onChange receives the number', () => {
    const onChange = vi.fn();
    render(<EqxSlider min={0} max={100} step={25} value={50} onChange={onChange} label="A" />);
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith(75);
  });

  it('marks switch on ticks and labels', () => {
    const { container, rerender } = render(<EqxSlider min={0} max={4} value={0} onChange={() => {}} label="A" />);
    expect(container.querySelectorAll('.MuiSlider-mark')).toHaveLength(0);
    rerender(<EqxSlider min={0} max={4} value={0} onChange={() => {}} label="A" marks />);
    expect(container.querySelectorAll('.MuiSlider-mark')).toHaveLength(5);
    rerender(
      <EqxSlider
        min={0}
        max={4}
        value={0}
        onChange={() => {}}
        label="A"
        marks={[
          { value: 0, label: 'Low' },
          { value: 4, label: 'High' },
        ]}
      />,
    );
    expect(container.querySelectorAll('.MuiSlider-mark')).toHaveLength(2);
    expect(screen.getByText('High')).toBeTruthy();
  });

  it('disabled blocks changes', () => {
    const onChange = vi.fn();
    render(<EqxSlider min={0} max={10} value={5} onChange={onChange} label="A" disabled />);
    const thumb = screen.getByRole('slider');
    expect(thumb).toHaveProperty('disabled', true);
    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
