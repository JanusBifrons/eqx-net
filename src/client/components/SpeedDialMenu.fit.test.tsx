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
import { availableListHeight, listFloor, FIT_EDGE_MARGIN_PX, FIT_MIN_HEIGHT_PX } from './speedDialFit.js';

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

/**
 * Command view: the build list never covers the bottom-centre stack (desktop
 * build palette, fleet panel / strip, status capsule). Desktop 1280×800: the
 * palette's right end sat under the open build list's lower entries.
 */
describe('SpeedDialMenu build list stops above the bottom-centre panels', () => {
  const DESK_H = 800;
  const DESK_LIST = { top: 108, bottom: 108 + 900, left: 1080, right: 1264 };
  let innerHeight: number;
  let host: HTMLElement;
  let stackRect: { top: number; bottom: number; left: number; right: number };

  beforeEach(() => {
    useUIStore.setState({ phase: 'galaxy-map', isDead: false, isGalaxyMapOpen: false });
    innerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: DESK_H });
    host = document.createElement('div');
    host.setAttribute('data-anchor', 'bottom-center');
    document.body.appendChild(host);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const r = this.hasAttribute('data-anchor') ? stackRect : DESK_LIST;
      return { ...r, width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top, toJSON: () => ({}) };
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    host.remove();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
  });

  function openEconomy(): HTMLElement {
    render(<SpeedDialMenu direction="down" />);
    fireEvent.click(screen.getByTestId('speed-dial-fab'));
    fireEvent.click(screen.getByTestId('speed-dial-build'));
    fireEvent.click(screen.getByTestId('build-cat-economy'));
    return screen.getByTestId('speed-dial').querySelector<HTMLElement>('.MuiSpeedDial-actions')!;
  }

  it('a build palette reaching under the list caps the list above the palette', () => {
    stackRect = { top: 680, bottom: 784, left: 40, right: 1240 };
    expect(openEconomy().style.maxHeight).toBe(`${680 - DESK_LIST.top - FIT_EDGE_MARGIN_PX}px`);
  });

  it('a fleet panel clear of the list leaves the list its full height', () => {
    stackRect = { top: 470, bottom: 784, left: 440, right: 840 };
    expect(openEconomy().style.maxHeight).toBe(`${DESK_H - DESK_LIST.top - FIT_EDGE_MARGIN_PX}px`);
  });

  it('listFloor: overlap, clear, and an empty (hidden) stack', () => {
    const col = { left: 700, right: 899 };
    expect(listFloor(col, { top: 230, bottom: 396, left: 282, right: 760 }, 412)).toBe(230);
    expect(listFloor(col, { top: 230, bottom: 396, left: 282, right: 640 }, 412)).toBe(412);
    expect(listFloor(col, { top: 396, bottom: 396, left: 457, right: 457 }, 412)).toBe(412);
    expect(listFloor(col, null, 412)).toBe(412);
    expect(availableListHeight({ top: 108, bottom: 0 }, 800, 'down', 680)).toBe(680 - 108 - FIT_EDGE_MARGIN_PX);
  });
});
