import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { EqxWindow } from './EqxWindow.js';
import { isAnyWindowOpen, onGameWindowOpen, useAnyWindowOpen } from './windowOpen.js';
import { GameWindow } from '../../client/components/GameWindow.js';

afterEach(() => { cleanup(); });

const base = { testId: 'w', closeTestId: 'w-x' };

describe('EqxWindow', () => {
  it('is the same component as the old GameWindow path', () => {
    expect(GameWindow).toBe(EqxWindow);
  });

  it('closed, it draws nothing', () => {
    render(<EqxWindow {...base} open={false} onClose={() => {}} title="Loot">body</EqxWindow>);
    expect(screen.queryByTestId('w')).toBeNull();
  });

  it('with a title it draws the header: title and a ✕ that closes', () => {
    const onClose = vi.fn();
    render(<EqxWindow {...base} open onClose={onClose} title="Wreck · Hauler">body</EqxWindow>);
    const root = screen.getByTestId('w');
    expect(root.getAttribute('data-game-window')).toBe('1');
    expect(root.textContent).toContain('Wreck · Hauler');
    expect(screen.getByRole('dialog').textContent).toContain('body');
    fireEvent.click(screen.getByTestId('w-x'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('with a title and a footer it draws the footer row under the body', () => {
    render(<EqxWindow {...base} open onClose={() => {}} title="Loot" footer={<button type="button">OK</button>}>body</EqxWindow>);
    expect(screen.getByRole('dialog').textContent).toMatch(/body.*OK/);
    expect(screen.getByRole('button', { name: 'OK' })).toBeTruthy();
  });

  it('without a title the content draws its own header (no ✕ of its own)', () => {
    render(<EqxWindow {...base} open onClose={() => {}}><div data-testid="own-head">mine</div></EqxWindow>);
    expect(screen.getByTestId('own-head')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('Esc closes it', () => {
    const onClose = vi.fn();
    render(<EqxWindow {...base} open onClose={onClose} title="Loot">body</EqxWindow>);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opening tells onGameWindowOpen listeners; unsubscribe stops them', () => {
    const fn = vi.fn();
    const off = onGameWindowOpen(fn);
    const { rerender } = render(<EqxWindow {...base} open={false} onClose={() => {}}>b</EqxWindow>);
    expect(fn).not.toHaveBeenCalled();
    rerender(<EqxWindow {...base} open onClose={() => {}}>b</EqxWindow>);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    rerender(<EqxWindow {...base} open={false} onClose={() => {}}>b</EqxWindow>);
    rerender(<EqxWindow {...base} open onClose={() => {}}>b</EqxWindow>);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('useAnyWindowOpen is true while any window is open, false once all close or unmount', () => {
    const hook = renderHook(() => useAnyWindowOpen());
    expect(hook.result.current).toBe(false);
    const a = render(<EqxWindow testId="a" open onClose={() => {}}>a</EqxWindow>);
    const b = render(<EqxWindow testId="b" open onClose={() => {}}>b</EqxWindow>);
    expect(hook.result.current).toBe(true);
    act(() => { a.rerender(<EqxWindow testId="a" open={false} onClose={() => {}}>a</EqxWindow>); });
    expect(hook.result.current).toBe(true);
    act(() => { b.unmount(); });
    expect(hook.result.current).toBe(false);
    expect(isAnyWindowOpen()).toBe(false);
  });
});
