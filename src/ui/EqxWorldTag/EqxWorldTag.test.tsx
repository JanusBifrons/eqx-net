import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HUD } from '../../client/hud/tokens.js';
import { EqxWorldTag } from './EqxWorldTag.js';

describe('EqxWorldTag', () => {
  it('renders the title and owner lines, named by both', () => {
    render(<EqxWorldTag title="Fighter · Vex" owner="Hostile" ownerColor="#ff6b6b" data-testid="t" />);
    const tag = screen.getByTestId('t');
    expect(tag).toHaveTextContent('Fighter · Vex');
    expect(tag).toHaveTextContent('Hostile');
    expect(tag.getAttribute('aria-label')).toBe('Fighter · Vex, Hostile');
    expect((screen.getByText('Hostile') as HTMLElement).style.color).toBe('rgb(255, 107, 107)');
  });

  it('no owner: title only', () => {
    render(<EqxWorldTag title="Asteroid" data-testid="t" />);
    expect(screen.getByTestId('t').textContent).toBe('Asteroid');
    expect(screen.getByTestId('t').getAttribute('aria-label')).toBe('Asteroid');
  });

  it('hullPct draws a clamped hull meter coloured by health; omitted = no bar', () => {
    const { rerender } = render(<EqxWorldTag title="A" hullPct={140} />);
    expect(screen.getByRole('meter', { name: 'Hull' }).getAttribute('aria-valuenow')).toBe('100');
    rerender(<EqxWorldTag title="A" hullPct={10} />);
    const fill = screen.getByRole('meter').firstElementChild as HTMLElement;
    expect(fill.style.width).toBe('10%');
    expect(HUD.color.hullCrit).toBe('#ff4d4d');
    expect(fill.style.backgroundColor).toBe('rgb(255, 77, 77)'); // hullCrit
    rerender(<EqxWorldTag title="A" />);
    expect(screen.queryByRole('meter')).toBeNull();
  });
});
