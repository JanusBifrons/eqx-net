import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EqxPanel } from './EqxPanel.js';
import { SidePanel } from '../../client/components/SidePanel.js';
import { HUD } from '../../client/hud/tokens.js';

function stubPortrait(portrait: boolean): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('portrait') ? portrait : false,
    media: q, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const base = { open: true, testId: 'p', title: 'Fleet orders', headerTestId: 'p-head', closeTestId: 'p-x' };

describe('EqxPanel', () => {
  it('is the same component as the old SidePanel path', () => {
    expect(SidePanel).toBe(EqxPanel);
  });

  it('header shows the title and a ✕ that closes', () => {
    const onClose = vi.fn();
    render(<EqxPanel {...base} onClose={onClose}>body</EqxPanel>);
    expect(screen.getByTestId('p-head').textContent).toContain('Fleet orders');
    expect(screen.queryByTestId('eqx-panel-back')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('onBack adds a ← back button', () => {
    const onBack = vi.fn();
    render(<EqxPanel {...base} onClose={() => {}} onBack={onBack}>body</EqxPanel>);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('Esc closes it with closeOnEscape', () => {
    const onClose = vi.fn();
    render(<EqxPanel {...base} onClose={onClose} closeOnEscape>body</EqxPanel>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a swipe right on the title closes it; a short one does not', () => {
    const onClose = vi.fn();
    render(<EqxPanel {...base} onClose={onClose} handleTestId="p-grab">body</EqxPanel>);
    const grab = screen.getByTestId('p-grab');
    fireEvent.pointerDown(grab, { clientX: 100, clientY: 10 });
    fireEvent.pointerUp(grab, { clientX: 120, clientY: 10 });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(grab, { clientX: 100, clientY: 10 });
    fireEvent.pointerUp(grab, { clientX: 200, clientY: 10 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the Apply footer appears only with apply', () => {
    const { rerender } = render(<EqxPanel {...base} onClose={() => {}}>body</EqxPanel>);
    expect(screen.queryByTestId('eqx-panel-footer')).toBeNull();
    const onApply = vi.fn();
    rerender(<EqxPanel {...base} onClose={() => {}} apply={{ onApply, dirty: false }}>body</EqxPanel>);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('dirty turns the footer amber (the manual token)', () => {
    const { rerender } = render(
      <EqxPanel {...base} onClose={() => {}} apply={{ onApply: () => {}, dirty: false }}>body</EqxPanel>);
    const clean = screen.getByTestId('eqx-panel-footer');
    expect(clean.getAttribute('data-dirty')).toBe('0');
    expect(getComputedStyle(clean).borderTopColor).not.toBe(getComputedStyle(document.body).color);
    rerender(<EqxPanel {...base} onClose={() => {}} apply={{ onApply: () => {}, dirty: true }}>body</EqxPanel>);
    const dirty = screen.getByTestId('eqx-panel-footer');
    expect(dirty.getAttribute('data-dirty')).toBe('1');
    expect(getComputedStyle(dirty).color).toBe('rgb(255, 176, 46)');
    expect(HUD.color.manual).toBe('#ffb02e');
  });

  it('docks right on landscape and as a bottom sheet on a portrait phone', () => {
    stubPortrait(false);
    const { unmount } = render(<EqxPanel {...base} onClose={() => {}}>body</EqxPanel>);
    expect(document.querySelector('.MuiDrawer-paperAnchorRight')).not.toBeNull();
    unmount();
    stubPortrait(true);
    render(<EqxPanel {...base} onClose={() => {}}>body</EqxPanel>);
    expect(document.querySelector('.MuiDrawer-paperAnchorBottom')).not.toBeNull();
  });
});
