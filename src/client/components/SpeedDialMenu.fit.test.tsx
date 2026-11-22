/**
 * The open dial list fits a sideways phone (Pixel 7 landscape, 412 px tall):
 * capped to the room below it, it scrolls inside itself. (The long build
 * lists that first needed this moved to the Build sidebar.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { SpeedDialMenu } from './SpeedDialMenu.js';
import { availableListHeight, listFloor, actionGapToFit, ACTION_GAP_VAR, FIT_EDGE_MARGIN_PX, FIT_MIN_HEIGHT_PX } from './speedDialFit.js';

const PHONE_H = 412;
const LIST_TOP = 110; // under the top-right toolbar

describe('SpeedDialMenu open list fits the screen', () => {
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

  it('the open list scrolls when it is taller than the screen', () => {
    render(<SpeedDialMenu direction="down" />);
    fireEvent.click(screen.getByTestId('speed-dial-fab'));

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
 * Command view: the open list never covers the bottom-centre stack (fleet
 * panel / strip, status capsule). Desktop 1280×800: a wide stack's right end
 * sat under the open list's lower entries.
 */
describe('SpeedDialMenu open list stops above the bottom-centre panels', () => {
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

  function openList(): HTMLElement {
    render(<SpeedDialMenu direction="down" />);
    fireEvent.click(screen.getByTestId('speed-dial-fab'));
    return screen.getByTestId('speed-dial').querySelector<HTMLElement>('.MuiSpeedDial-actions')!;
  }

  it('a bottom stack reaching under the list caps the list above the stack', () => {
    stackRect = { top: 680, bottom: 784, left: 40, right: 1240 };
    expect(openList().style.maxHeight).toBe(`${680 - DESK_LIST.top - FIT_EDGE_MARGIN_PX}px`);
  });

  it('a fleet panel clear of the list leaves the list its full height', () => {
    stackRect = { top: 470, bottom: 784, left: 440, right: 840 };
    expect(openList().style.maxHeight).toBe(`${DESK_H - DESK_LIST.top - FIT_EDGE_MARGIN_PX}px`);
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

/**
 * The main action list fits a sideways phone without scrolling (Pixel 7
 * landscape, 863x360). With Warp ▸ shown, Build ▸ sat partly below the screen
 * bottom and could only be reached by scrolling the list. When the list is a
 * little taller than the room, the gap between its buttons shrinks so every
 * entry is on screen; every entry and its look stay.
 */
describe('SpeedDialMenu main list fits 863x360 with Warp shown', () => {
  const SHORT_H = 360;
  const TOP = 60; // the list's top under the toolbar
  const BTN = 40; // an action button
  let innerHeight: number;
  beforeEach(() => {
    useUIStore.setState({ phase: 'galaxy-map', isDead: false, isGalaxyMapOpen: false, currentSectorKey: '0,0', buildMode: false, placementKind: null });
    innerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: SHORT_H });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const h = this.classList.contains('MuiSpeedDialAction-fab') ? BTN : 400;
      return { top: TOP, bottom: TOP + h, left: 0, right: 0, width: BTN, height: h, x: 0, y: TOP, toJSON: () => ({}) };
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useUIStore.setState({ currentSectorKey: null });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
  });

  it('every main-menu entry fits without scrolling', () => {
    render(<SpeedDialMenu direction="down" />);
    fireEvent.click(screen.getByTestId('speed-dial-fab'));
    expect(screen.getByTestId('speed-dial-warp')).toBeTruthy();
    expect(screen.queryByTestId('speed-dial-build')).toBeNull(); // the dial no longer builds

    const list = screen.getByTestId('speed-dial').querySelector<HTMLElement>('.MuiSpeedDial-actions')!;
    const n = list.children.length;
    expect(n).toBe(4);
    const max = parseFloat(list.style.maxHeight);
    expect(max).toBe(SHORT_H - TOP - FIT_EDGE_MARGIN_PX);
    const cs = getComputedStyle(list);
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const gapVar = list.style.getPropertyValue(ACTION_GAP_VAR);
    const gap = gapVar ? parseFloat(gapVar) : 8; // MUI's default button margin
    expect(pad + n * (BTN + 2 * gap)).toBeLessThanOrEqual(max);
  });

  it('actionGapToFit: full gap when it fits, squeezed when a little short, full (scroll) when long', () => {
    expect(actionGapToFit(400, 5, 40, 48)).toBe(8);
    expect(actionGapToFit(292, 5, 40, 48)).toBe(4);
    expect(actionGapToFit(268, 5, 40, 48)).toBe(2);
    expect(actionGapToFit(242, 11, 40, 48)).toBe(8);
  });
});
