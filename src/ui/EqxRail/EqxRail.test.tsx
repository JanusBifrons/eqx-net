import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import PublicIcon from '@mui/icons-material/Public';
import WorkIcon from '@mui/icons-material/Work';
import TuneIcon from '@mui/icons-material/Tune';
import { EqxRail, RAIL_COG_ID, RAIL_MAX_ITEMS, type EqxRailItem } from './EqxRail.js';
import { HUD } from '../../client/hud/tokens.js';

const ITEMS: EqxRailItem[] = [
  { id: 'galaxy', icon: <PublicIcon />, tooltip: 'Galaxy' },
  { id: 'jobs', icon: <WorkIcon />, tooltip: 'Jobs' },
  { id: 'trade', icon: <TuneIcon fontSize="large" />, tooltip: 'Trade' },
];

function many(n: number): EqxRailItem[] {
  return Array.from({ length: n }, (_, i) => ({ id: `i${i}`, icon: <PublicIcon />, tooltip: `Item ${i}` }));
}

function visibleText(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent?.trim();
    if (t) out.push(t);
  }
  return out;
}

describe('EqxRail', () => {
  it('renders items top to bottom with the cog last, and no visible text nodes', () => {
    render(<EqxRail items={ITEMS} onPick={() => {}} cog data-testid="rail" />);
    const rail = screen.getByTestId('rail');
    expect(visibleText(rail)).toEqual([]);
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['Galaxy', 'Jobs', 'Trade', 'Settings']);
  });

  it('calls onPick with the item id, and the cog id for the cog', () => {
    const onPick = vi.fn();
    render(<EqxRail items={ITEMS} onPick={onPick} cog={{ icon: <TuneIcon />, tooltip: 'Options', id: 'opts' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Jobs' }));
    expect(onPick).toHaveBeenLastCalledWith('jobs');
    fireEvent.click(screen.getByRole('button', { name: 'Options' }));
    expect(onPick).toHaveBeenLastCalledWith('opts');
  });

  it('cog={true} uses the default cog with the default id', () => {
    const onPick = vi.fn();
    render(<EqxRail items={ITEMS} onPick={onPick} cog />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onPick).toHaveBeenCalledWith(RAIL_COG_ID);
  });

  it('no cog when cog is omitted', () => {
    render(<EqxRail items={ITEMS} onPick={() => {}} />);
    expect(screen.getAllByRole('button')).toHaveLength(ITEMS.length);
  });

  it('activeId marks exactly one item active', () => {
    const { rerender } = render(<EqxRail items={ITEMS} onPick={() => {}} cog activeId="trade" />);
    const pressed = () => screen.getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed().map((b) => b.getAttribute('aria-label'))).toEqual(['Trade']);
    rerender(<EqxRail items={ITEMS} onPick={() => {}} cog activeId={RAIL_COG_ID} />);
    expect(pressed().map((b) => b.getAttribute('aria-label'))).toEqual(['Settings']);
    rerender(<EqxRail items={ITEMS} onPick={() => {}} cog />);
    expect(pressed()).toHaveLength(0);
  });

  it('every button, cog included, is the same box', () => {
    render(<EqxRail items={ITEMS} onPick={() => {}} cog />);
    const px = `${HUD.size.iconButton}px`;
    for (const b of screen.getAllByRole('button')) {
      const cs = getComputedStyle(b);
      expect({ w: cs.width, h: cs.height }).toEqual({ w: px, h: px });
    }
  });

  it('holds 8 items plus the cog; more than 8 throws in dev', () => {
    render(<EqxRail items={many(RAIL_MAX_ITEMS)} onPick={() => {}} cog />);
    expect(screen.getAllByRole('button')).toHaveLength(RAIL_MAX_ITEMS + 1);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<EqxRail items={many(RAIL_MAX_ITEMS + 1)} onPick={() => {}} cog />)).toThrow(/at most 8/);
    err.mockRestore();
  });

  it('compact switches the width between the phone and desktop rail tokens; fills parent height', () => {
    const { rerender } = render(<EqxRail items={ITEMS} onPick={() => {}} compact data-testid="rail" />);
    const rail = () => screen.getByTestId('rail');
    expect(rail().dataset['compact']).toBe('true');
    expect(getComputedStyle(rail()).width).toBe(`${HUD.size.railPhone}px`);
    expect(getComputedStyle(rail()).height).toBe('100%');
    expect(getComputedStyle(rail()).position).not.toBe('fixed');
    rerender(<EqxRail items={ITEMS} onPick={() => {}} compact={false} data-testid="rail" />);
    expect(rail().dataset['compact']).toBe('false');
    expect(getComputedStyle(rail()).width).toBe(`${HUD.size.railDesktop}px`);
  });
});
