import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EQX_PANEL_SIZE, EqxPanel, rightPaperSx } from './EqxPanel.js';
import { SidePanel } from '../../client/components/SidePanel.js';

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

  it('the Apply footer appears only with apply; Apply is off until something changed', () => {
    const { rerender } = render(<EqxPanel {...base} onClose={() => {}}>body</EqxPanel>);
    expect(screen.queryByTestId('eqx-panel-footer')).toBeNull();
    const onApply = vi.fn();
    rerender(<EqxPanel {...base} onClose={() => {}} apply={{ onApply, dirty: false }}>body</EqxPanel>);
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply).toHaveProperty('disabled', true);
    expect(apply.dataset['tone']).toBe('primary');
    rerender(<EqxPanel {...base} onClose={() => {}} apply={{ onApply, dirty: true }}>body</EqxPanel>);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('dirty Apply stays the plain cyan primary, enabled (never amber)', () => {
    render(<EqxPanel {...base} onClose={() => {}} apply={{ onApply: () => {}, dirty: true }}>body</EqxPanel>);
    expect(screen.getByTestId('eqx-panel-footer').getAttribute('data-dirty')).toBe('1');
    const apply = screen.getByTestId('eqx-panel-apply');
    expect(apply.dataset['tone']).toBe('primary');
    expect(apply).toHaveProperty('disabled', false);
    expect(getComputedStyle(apply).backgroundColor).toBe('rgb(52, 216, 255)');
  });

  it('a secondary footer action sits beside Apply', () => {
    const onStop = vi.fn();
    render(<EqxPanel {...base} onClose={() => {}}
      apply={{ onApply: () => {}, dirty: false, secondary: { label: 'Stop', onClick: onStop } }}>body</EqxPanel>);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('the body sits between header and footer and takes the spare height', () => {
    render(<EqxPanel {...base} onClose={() => {}} apply={{ onApply: () => {}, dirty: false }}>body</EqxPanel>);
    const bodyEl = screen.getByTestId('eqx-panel-body');
    expect(bodyEl.previousElementSibling).toBe(screen.getByTestId('p-head'));
    expect(bodyEl.nextElementSibling).toBe(screen.getByTestId('eqx-panel-footer'));
    expect(getComputedStyle(bodyEl).flexGrow).toBe('1');
    expect(getComputedStyle(bodyEl).overflowY).toBe('auto');
  });

  it('EQX_PANEL_SIZE docks flush, full height, on the right edge', () => {
    for (const touch of [false, true]) {
      expect(rightPaperSx(EQX_PANEL_SIZE, touch)).toMatchObject({ top: 0, bottom: 0, height: '100dvh', borderRadius: 0 });
    }
    expect(rightPaperSx(EQX_PANEL_SIZE, true)['width']).toBe('clamp(300px, 36vw, 380px)');
    expect(rightPaperSx(EQX_PANEL_SIZE, false)['width']).toBe('min(380px, 36vw)');
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
