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
    expect(screen.getByTestId('t').querySelector('[data-world-tag-full]')!.textContent).toBe('Asteroid');
    expect(screen.getByTestId('t').getAttribute('aria-label')).toBe('Asteroid');
  });

  it('S9 edge hooks: a hidden arrow + distance row, the arrow in the relation colour', () => {
    render(<EqxWorldTag title="A" owner="Hostile" ownerColor="#ff6b6b" data-testid="t" />);
    const tag = screen.getByTestId('t');
    const arrow = tag.querySelector<HTMLElement>('[data-world-tag-arrow]')!;
    expect(arrow.style.borderLeftColor).toBe('rgb(255, 107, 107)');
    expect(tag.querySelector('[data-world-tag-edge]')).not.toBeNull();
    expect(tag.querySelector('[data-world-tag-dist]')).not.toBeNull();
    expect(tag.querySelector('[data-world-tag-pointer]')).not.toBeNull();
  });

  it('S10 compact: one line (compactTitle + owner-colour dot), no owner line or hull bar; pointer stays', () => {
    render(<EqxWorldTag title="Fighter · Vex" compactTitle="Fighter" owner="Hostile" ownerColor="#ff6b6b" hullPct={50} compact data-testid="t" />);
    const tag = screen.getByTestId('t');
    expect(tag.getAttribute('data-compact')).toBe('1');
    const compactRow = tag.querySelector<HTMLElement>('[data-world-tag-compact]')!;
    expect(compactRow.textContent).toBe('Fighter');
    expect(tag.querySelector<HTMLElement>('[data-world-tag-dot]')!.style.backgroundColor).toBe('rgb(255, 107, 107)');
    // CSS shows one layout by data-compact: compact hides the full block.
    expect(getComputedStyle(tag.querySelector('[data-world-tag-full]')!).display).toBe('none');
    expect(getComputedStyle(compactRow).display).not.toBe('none');
    expect(tag.querySelector('[data-world-tag-pointer]')).not.toBeNull();
  });

  it('S10 not compact: the compact row is hidden, the full layout shows; compactTitle defaults to title', () => {
    render(<EqxWorldTag title="Asteroid" data-testid="t" />);
    const tag = screen.getByTestId('t');
    expect(tag.getAttribute('data-compact')).toBe('0');
    const compactRow = tag.querySelector<HTMLElement>('[data-world-tag-compact]')!;
    expect(compactRow.textContent).toBe('Asteroid');
    expect(getComputedStyle(compactRow).display).toBe('none');
    expect(getComputedStyle(tag.querySelector('[data-world-tag-full]')!).display).not.toBe('none');
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
