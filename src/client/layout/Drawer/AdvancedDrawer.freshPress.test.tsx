/**
 * Owner bug class (phone playtest 2026-11-21): the dial's Menu action opens
 * the drawer on touchstart, and the same finger's release (the browser's
 * synthesized click) landed on whatever drawer tab, row or backdrop was now
 * under it. Inside the drawer only a fresh press counts: a pointerdown in the
 * drawer after it opened (touch: at least MENU_ARM_MS after), then the click.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AdvancedDrawer } from './AdvancedDrawer';
import { MENU_ARM_MS } from '../../components/touchClickActivate';
import { useUIStore } from '../../state/store';

/** A tap's synthesized click carries detail 1 (a keyboard click carries 0). */
const tapClick = (el: Element): void => { fireEvent.click(el, { detail: 1 }); };
const touchDown = (el: Element): void => { fireEvent.pointerDown(el, { pointerType: 'touch' }); };

beforeEach(() => {
  vi.useFakeTimers();
  useUIStore.setState({ isDrawerOpen: false, drawerTab: 'galaxy' });
});
afterEach(() => { useUIStore.setState({ isDrawerOpen: false }); vi.useRealTimers(); });

function openByPress(): void {
  render(<AdvancedDrawer />);
  act(() => { useUIStore.getState().setDrawerOpen(true); });
}

describe('AdvancedDrawer: the opening press never acts inside it', () => {
  it('the leftover release on Close does not close the drawer', () => {
    openByPress();
    tapClick(screen.getByTestId('drawer-close'));
    expect(useUIStore.getState().isDrawerOpen).toBe(true);
  });

  it('the leftover release on a tab does not switch tabs', () => {
    openByPress();
    tapClick(screen.getByTestId('drawer-tab-settings'));
    expect(useUIStore.getState().drawerTab).toBe('galaxy');
  });

  it('a touch press inside the arming delay is ignored; a fresh one after it acts', () => {
    openByPress();
    const tab = screen.getByTestId('drawer-tab-settings');
    act(() => { vi.advanceTimersByTime(MENU_ARM_MS - 100); });
    touchDown(tab); tapClick(tab);
    expect(useUIStore.getState().drawerTab).toBe('galaxy');
    act(() => { vi.advanceTimersByTime(200); });
    touchDown(tab); tapClick(tab);
    expect(useUIStore.getState().drawerTab).toBe('settings');
  });

  it('a mouse press counts at once (a mouse opens on release: nothing left over)', () => {
    openByPress();
    const tab = screen.getByTestId('drawer-tab-settings');
    fireEvent.pointerDown(tab, { pointerType: 'mouse' }); tapClick(tab);
    expect(useUIStore.getState().drawerTab).toBe('settings');
  });

  it('keyboard activation (detail 0) still acts', () => {
    openByPress();
    fireEvent.click(screen.getByTestId('drawer-close'));
    expect(useUIStore.getState().isDrawerOpen).toBe(false);
  });
});
