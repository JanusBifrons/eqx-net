/**
 * Speed-dial close()-blurs-focus regression lock (WS-F #18).
 *
 * Symptom (user, manual play): clicking the Map action via the speed-dial
 * closes the dial + opens the galaxy overlay, but the Map FAB button KEEPS DOM
 * focus. MUI Fab buttons activate on Space/Enter while focused, so the next
 * Space (Fire) re-triggers the focused Map button and re-opens the map — the
 * pilot's fire key silently flips the overlay instead.
 *
 * Root cause: `close()` only updates Zustand/local React state; nothing blurs
 * the activated button, so it stays `document.activeElement`.
 *
 * Fix: `close()` blurs the active element — every terminal speed-dial action
 * (Panels / Map / Weapon) routes through `close()`, so all of them lose focus.
 *
 * This is the runnable fail-first lock for the blur behaviour (the E2E
 * `speed-dial-focus-blur.spec.ts` is the end-to-end Space-press lock, written
 * but not run here — port conflict with parallel workstreams). It asserts at
 * the component level that after a terminal action the previously-focused
 * button is no longer `document.activeElement`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { SpeedDialMenu } from './SpeedDialMenu.js';

describe('SpeedDialMenu close() blurs focus (WS-F #18)', () => {
  beforeEach(() => {
    // Defaults already satisfy useShouldRenderHud (phase 'galaxy-map' ⇒ not
    // loading) and isDead=false, but pin them so the dial mounts deterministically.
    useUIStore.setState({ phase: 'galaxy-map', isDead: false, isGalaxyMapOpen: false });
  });

  function openDial(): void {
    // The FAB toggles open; opening reveals the action buttons.
    fireEvent.click(screen.getByTestId('speed-dial-fab'));
  }

  it('blurs the Map button when the Map action closes the dial', () => {
    render(<SpeedDialMenu />);
    openDial();

    const mapBtn = screen.getByTestId('galaxy-map-toggle') as HTMLElement;
    // Simulate the focus a real click leaves on the button.
    act(() => mapBtn.focus());
    expect(document.activeElement).toBe(mapBtn);

    // Activate the Map action → toggles the overlay AND closes the dial.
    fireEvent.click(mapBtn);

    // The overlay toggled (sanity that the action ran)…
    expect(useUIStore.getState().isGalaxyMapOpen).toBe(true);
    // …and focus was dropped, so a subsequent Space/Fire cannot re-activate it.
    expect(document.activeElement).not.toBe(mapBtn);
  });

  it('blurs the Panels button when the Menu action closes the dial', () => {
    render(<SpeedDialMenu />);
    openDial();

    const menuBtn = screen.getByTestId('speed-dial-menu') as HTMLElement;
    act(() => menuBtn.focus());
    expect(document.activeElement).toBe(menuBtn);

    fireEvent.click(menuBtn);

    // The Menu action opens the drawer and closes the dial; focus is dropped.
    expect(useUIStore.getState().isDrawerOpen).toBe(true);
    expect(document.activeElement).not.toBe(menuBtn);
  });
});
