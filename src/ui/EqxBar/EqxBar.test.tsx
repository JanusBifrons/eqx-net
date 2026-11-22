import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HUD } from '../../client/hud/tokens.js';
import { EqxBar, barColor } from './EqxBar.js';

describe('EqxBar', () => {
  it('a labelled bar is one row: label text and a meter', () => {
    render(<EqxBar label="Hull" pct={64} data-testid="b" />);
    const row = screen.getByTestId('b');
    expect(row).toHaveTextContent('Hull');
    expect(row.getAttribute('data-pct')).toBe('64');
    expect(screen.getByRole('meter', { name: 'Hull' }).getAttribute('aria-valuenow')).toBe('64');
  });

  it('clamps pct to 0..100', () => {
    render(<EqxBar pct={140} data-testid="b" />);
    expect(screen.getByTestId('b').getAttribute('data-pct')).toBe('100');
  });

  it('short: a bare track, no label text', () => {
    render(<EqxBar pct={30} short label="Hull" data-testid="b" />);
    expect(screen.getByTestId('b').textContent).toBe('');
    expect(screen.getByTestId('b').getAttribute('role')).toBe('meter');
  });

  it('tone picks the fill: hull thresholds, shield cyan, charge', () => {
    expect(barColor('hull', 80)).toBe(HUD.color.hullOk);
    expect(barColor('hull', 40)).toBe(HUD.color.hullWarn);
    expect(barColor('hull', 10)).toBe(HUD.color.hullCrit);
    expect(barColor('shield', 10)).toBe(HUD.color.shield);
    expect(barColor('charge', 10)).toBe(HUD.bar.charge);
  });

  it('tone is reported for tests and styling', () => {
    render(<EqxBar label="Shield" tone="shield" pct={50} data-testid="b" />);
    expect(screen.getByTestId('b').getAttribute('data-tone')).toBe('shield');
  });
});
