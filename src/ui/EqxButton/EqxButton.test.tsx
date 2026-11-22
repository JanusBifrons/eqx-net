import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EqxButton, TONE_COLOR } from './EqxButton.js';
import { HUD } from '../../client/hud/tokens.js';

describe('EqxButton', () => {
  it('renders its text and forwards data-testid', () => {
    render(<EqxButton data-testid="b">Launch</EqxButton>);
    expect(screen.getByRole('button', { name: 'Launch' })).toBe(screen.getByTestId('b'));
  });

  it('calls onClick', () => {
    const onClick = vi.fn();
    render(<EqxButton onClick={onClick}>Go</EqxButton>);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('tone switches variant and token colour', () => {
    const { rerender } = render(<EqxButton data-testid="b">X</EqxButton>);
    const b = () => screen.getByTestId('b');
    expect(b().dataset['tone']).toBe('secondary');
    expect(b().className).toContain('MuiButton-outlined');
    rerender(<EqxButton data-testid="b" tone="primary">X</EqxButton>);
    expect(b().dataset['tone']).toBe('primary');
    expect(b().className).toContain('MuiButton-contained');
    rerender(<EqxButton data-testid="b" tone="danger">X</EqxButton>);
    expect(b().dataset['tone']).toBe('danger');
    expect(b().className).toContain('MuiButton-outlined');
    expect(TONE_COLOR).toEqual({ primary: HUD.color.brand, secondary: HUD.color.ink, danger: HUD.color.danger, manual: HUD.color.manual });
  });

  it('manual tone is outlined amber', () => {
    render(<EqxButton data-testid="b" tone="manual">Apply</EqxButton>);
    const b = screen.getByTestId('b');
    expect(b.dataset['tone']).toBe('manual');
    expect(b.className).toContain('MuiButton-outlined');
    expect(getComputedStyle(b).color).toBe('rgb(255, 176, 46)');
  });

  it('size switches MUI size, small by default', () => {
    const { rerender } = render(<EqxButton data-testid="b">X</EqxButton>);
    expect(screen.getByTestId('b').className).toContain('MuiButton-sizeSmall');
    rerender(<EqxButton data-testid="b" size="large">X</EqxButton>);
    expect(screen.getByTestId('b').className).toContain('MuiButton-sizeLarge');
  });

  it('disabled blocks clicks', () => {
    const onClick = vi.fn();
    render(<EqxButton disabled onClick={onClick}>X</EqxButton>);
    const b = screen.getByRole('button');
    expect(b).toHaveProperty('disabled', true);
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });
});
