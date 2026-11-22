import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { EqxTooltip } from './EqxTooltip.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('EqxTooltip', () => {
  it('renders its child with no tooltip shown', () => {
    render(
      <EqxTooltip title="Galaxy">
        <button type="button">g</button>
      </EqxTooltip>,
    );
    expect(screen.getByRole('button')).toBeTruthy();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows the title on hover (desktop)', async () => {
    render(
      <EqxTooltip title="Galaxy">
        <button type="button">g</button>
      </EqxTooltip>,
    );
    fireEvent.mouseOver(screen.getByRole('button'));
    expect((await screen.findByRole('tooltip')).textContent).toBe('Galaxy');
  });

  it('shows on long-press only after holdMs (touch)', () => {
    vi.useFakeTimers();
    render(
      <EqxTooltip title="Galaxy" holdMs={400}>
        <button type="button">g</button>
      </EqxTooltip>,
    );
    fireEvent.touchStart(screen.getByRole('button'));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByRole('tooltip').textContent).toBe('Galaxy');
  });
});
