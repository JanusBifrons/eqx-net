/**
 * Top-left HUD steadiness (#13 — failing test first).
 *
 * Film 2026-11-26 (Ancients' gate swap): the net-health chip cleared after
 * arrival and the whole top-left column (the mode bar under the sector chip)
 * jumped up ~7 px, because the chip shared the sector chip's row and was the
 * taller of the two. With nothing to show, the cluster keeps an invisible box
 * of the same build (one chip), so the row's height never changes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NetHealthCluster } from './NetHealthCluster.js';

afterEach(cleanup);

describe('NetHealthCluster: no warnings', () => {
  it('shows nothing but keeps its row height with an invisible, untouchable box', () => {
    render(<NetHealthCluster size={9} />);
    expect(screen.queryByTestId('hud-net-health')).toBeNull();
    const reserve = screen.getByTestId('hud-net-health-reserve');
    expect(reserve.style.visibility).toBe('hidden');
    expect(reserve.style.pointerEvents).toBe('none');
    expect(reserve.getAttribute('aria-hidden')).toBe('true');
    expect(reserve.hasAttribute('data-hud-exclusion')).toBe(false);
    // Same box as the live cluster: its padding and border, one icon chip.
    expect(reserve.style.padding).toBe('3px 6px');
    expect(reserve.style.border).toMatch(/^1px solid/);
    expect(reserve.querySelectorAll('svg').length).toBe(1);
  });
});
