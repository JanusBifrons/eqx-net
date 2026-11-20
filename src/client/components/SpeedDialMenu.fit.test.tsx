/**
 * The build list fits a sideways phone (Pixel 7 landscape, 412 px tall).
 *
 * Bug (in-game stills): the longer build categories ran off the bottom of the
 * screen, so the Shipyard sat at y≈726 and could not be tapped. The open list
 * is now capped to the room below it and scrolls inside itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { SpeedDialMenu } from './SpeedDialMenu.js';
import { availableListHeight, FIT_EDGE_MARGIN_PX, FIT_MIN_HEIGHT_PX } from './speedDialFit.js';

const PHONE_H = 412;
const LIST_TOP = 110; // under the top-right toolbar

describe('SpeedDialMenu build list fits the screen', () => {
  let innerHeight: number;
  beforeEach(() => {
    useUIStore.setState({ phase: 'galaxy-map', isDead: false, isGalaxyMapOpen: false });
    innerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: PHONE_H });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ top: LIST_TOP, bottom: LIST_TOP + 900, left: 0, right: 0, width: 0, height: 900, x: 0, y: LIST_TOP, toJSON: () => ({}) }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
  });

  it('the build list scrolls when it is taller than the screen', () => {
    render(<SpeedDialMenu direction="down" />);
    fireEvent.click(screen.getByTestId('speed-dial-fab'));
    fireEvent.click(screen.getByTestId('speed-dial-build'));
    fireEvent.click(screen.getByTestId('build-cat-economy'));

    const list = screen.getByTestId('speed-dial').querySelector<HTMLElement>('.MuiSpeedDial-actions');
    expect(list).not.toBeNull();
    // Capped to the room between the list's top and the screen's bottom edge…
    expect(list!.style.maxHeight).toBe(`${PHONE_H - LIST_TOP - FIT_EDGE_MARGIN_PX}px`);
    // …and it scrolls inside itself without panning the game.
    const cs = getComputedStyle(list!);
    expect(cs.overflowY).toBe('auto');
    expect(cs.getPropertyValue('overscroll-behavior')).toBe('contain');
  });

  it('upward lists measure the room above; a tiny window keeps a minimum', () => {
    expect(availableListHeight({ top: 0, bottom: 300 }, PHONE_H, 'up')).toBe(300 - FIT_EDGE_MARGIN_PX);
    expect(availableListHeight({ top: 400, bottom: 0 }, PHONE_H, 'down')).toBe(FIT_MIN_HEIGHT_PX);
  });
});
