/**
 * The "Can't connect: too close" hint under the placement ghost: shown by a
 * direct DOM write when the preview's only links were refused too short.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { belowGhostPx, setPlacementHudInsets, updatePlacementHints, TOO_CLOSE_LINK_TEXT } from './placementHints';
import { turretRangeOf } from './fenceFireHint';
import { EMPTY_RADAR_INSETS } from '../../shared-types/settings/radar.js';
import type { StructureRenderState, SwarmRenderState } from '../../core/contracts/IRenderer.js';

const mirror = { structures: new Map(), swarm: new Map() };
// Two connected shield pylons: a wall along x = 1000, y 0..600 (as in fenceFireHint.test).
const pylon = (x: number, y: number) => ({ x, y, vx: 0, vy: 0, angle: 0, kind: 2, radius: 50, shipKind: 'shield_pylon' }) as unknown as SwarmRenderState;
const wall = (connTo: number[]) => ({ powered: true, netPower: 0, connTo, built: true, buildPct: 1, deconstructPct: 0, wallActive: true }) as StructureRenderState;
const fenceMirror = { structures: new Map([[1, wall([2])], [2, wall([1])]]), swarm: new Map([[1, pylon(1000, 0)], [2, pylon(1000, 600)]]) };

describe('updatePlacementHints: too-close link hint', () => {
  let el: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    el = document.createElement('div');
    el.dataset.testid = 'placement-link-hint';
    el.textContent = TOO_CLOSE_LINK_TEXT;
    el.hidden = true;
    document.body.appendChild(el);
  });

  it('shows under the ghost when a link is too short and none forms', () => {
    updatePlacementHints({ placementPreviewConnectionCount: 0, placementPreviewTooShortCount: 1, placementPreviewRejection: null, viewHalf: 0 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.hidden).toBe(false);
    expect(el.style.left).toBe('200px');
    expect(el.textContent).toBe("Can't connect: too close");
  });

  it('stays hidden when another link forms, and hides again when the ghost moves away', () => {
    updatePlacementHints({ placementPreviewConnectionCount: 1, placementPreviewTooShortCount: 1, placementPreviewRejection: null, viewHalf: 0 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.hidden).toBe(true);
    updatePlacementHints({ placementPreviewConnectionCount: 0, placementPreviewTooShortCount: 1, placementPreviewRejection: null, viewHalf: 0 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.hidden).toBe(false);
    updatePlacementHints({ placementPreviewConnectionCount: 0, placementPreviewTooShortCount: 0, placementPreviewRejection: null, viewHalf: 0 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.hidden).toBe(true);
  });

  it('says why the ghost cannot go there (the server notice), over "too close"', () => {
    updatePlacementHints({ placementPreviewConnectionCount: 0, placementPreviewTooShortCount: 1, placementPreviewRejection: 'overlap-obstacle', viewHalf: 0 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe("Can't build here: blocked by an asteroid or wreck");
    // Moved clear: back to the too-close line, then hidden.
    updatePlacementHints({ placementPreviewConnectionCount: 0, placementPreviewTooShortCount: 1, placementPreviewRejection: null, viewHalf: 0 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.textContent).toBe(TOO_CLOSE_LINK_TEXT);
    updatePlacementHints({ placementPreviewConnectionCount: 1, placementPreviewTooShortCount: 0, placementPreviewRejection: null, viewHalf: 0 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.hidden).toBe(true);
  });

  it('follows the ghost on every device (the placing tools are on the left strip; no docked copy)', () => {
    updatePlacementHints({ placementPreviewConnectionCount: 0, placementPreviewTooShortCount: 1, placementPreviewRejection: null, viewHalf: 0 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.hidden).toBe(false);
    expect(el.style.left).toBe('200px');
  });

  it('sits just below the ghost edge at any zoom (a 1000 u dock at 2 px per unit)', () => {
    // 1280-wide window showing 640 u each side of centre: 1 px per unit; viewHalf 320: 2 px per unit.
    expect(belowGhostPx('freight_dock', 640, 1280, 800)).toBeCloseTo(500 + 10);
    expect(belowGhostPx('freight_dock', 320, 1280, 800)).toBeCloseTo(1000 + 10);
    expect(belowGhostPx('battery', 0, 1280, 800)).toBe(10);
  });
});

describe('updatePlacementHints: the hint block stays on screen and clear of the HUD', () => {
  const W = 863; const H = 360; // a phone held sideways (CSS px)
  let link: HTMLElement;
  let fence: HTMLElement;
  const sized = (testid: string, w: number, h: number): HTMLElement => {
    const el = document.createElement('div');
    el.dataset.testid = testid;
    el.hidden = true;
    Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => (el.hidden ? 0 : w) });
    Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => (el.hidden ? 0 : h) });
    document.body.appendChild(el);
    return el;
  };
  /** The label's box: `left` is its centre (CSS `translateX(-50%)`), `top` its top. */
  const box = (el: HTMLElement, w: number, h: number) => {
    const cx = parseFloat(el.style.left); const top = parseFloat(el.style.top);
    return { x: cx - w / 2, y: top, r: cx + w / 2, b: top + h };
  };
  const refused = { placementPreviewConnectionCount: 0, placementPreviewTooShortCount: 0, placementPreviewRejection: 'off-deck', viewHalf: 0 } as const;
  const turretX = (): number => 1000 - turretRangeOf('turret') + 50;
  beforeEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: W });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: H });
    link = sized('placement-link-hint', 200, 18);
    fence = sized('placement-fence-hint', 240, 18);
    setPlacementHudInsets(EMPTY_RADAR_INSETS);
  });

  it('a ghost past the left edge keeps the whole label on screen', () => {
    updatePlacementHints(refused, -30, 150, 'connector', 0, 0, mirror);
    const b = box(link, 200, 18);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.r).toBeLessThanOrEqual(W);
  });

  it('clears the left strip (Place / Rotate / Mirror / Cancel)', () => {
    setPlacementHudInsets({ top: 0, right: 0, bottom: 0, left: 0, exclusions: [{ x: 0, y: 40, w: 56, h: 280 }] });
    updatePlacementHints(refused, 40, 150, 'connector', 0, 0, mirror);
    expect(box(link, 200, 18).x).toBeGreaterThanOrEqual(56);
  });

  it('clears the wallet pill at the bottom centre and the right rail', () => {
    setPlacementHudInsets({ top: 0, right: 60, bottom: 0, left: 0, exclusions: [{ x: 330, y: 316, w: 200, h: 32 }] });
    updatePlacementHints(refused, 430, 320, 'connector', 0, 0, mirror);
    expect(box(link, 200, 18).b).toBeLessThanOrEqual(316);
    updatePlacementHints(refused, W - 10, 150, 'connector', 0, 0, mirror);
    expect(box(link, 200, 18).r).toBeLessThanOrEqual(W - 60);
  });

  it('the fence hint and a refusal never overlap: the refusal first, the fence line under it', () => {
    updatePlacementHints(refused, 400, 150, 'turret', turretX(), 300, fenceMirror);
    expect(link.hidden).toBe(false);
    expect(fence.hidden).toBe(false);
    const l = box(link, 200, 18); const f = box(fence, 240, 18);
    expect(f.y).toBeGreaterThanOrEqual(l.b);
    // Pushed up off the bottom edge: still stacked, still on screen.
    updatePlacementHints(refused, 400, H - 5, 'turret', turretX(), 300, fenceMirror);
    const l2 = box(link, 200, 18); const f2 = box(fence, 240, 18);
    expect(f2.y).toBeGreaterThanOrEqual(l2.b);
    expect(f2.b).toBeLessThanOrEqual(H);
  });
});
