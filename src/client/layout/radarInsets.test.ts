// @vitest-environment jsdom
/**
 * The off-screen radar keeps its icons out from under the DOM HUD
 * (radarInsets.ts). CI 2026-11-22 (radar-sandbox.spec.ts, sideways Pixel 5,
 * 727x393): `swarm:4 at (713,197) is under a HUD widget` — the right rail
 * (x 679-727, full height) was never measured, so the right-edge track ran
 * underneath it. Every edge anchor (right rail and left strip included) must
 * keep the radar clear; only the full-screen overlay hosts never do.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ANCHOR_NAMES, type AnchorName } from './anchors';
import { measureRadarInsets } from './radarInsets';

const W = 727;
const H = 393;
const OVERLAYS: readonly AnchorName[] = ['fullscreen', 'transit', 'rotate'];

function rectEl(tag: string, x: number, y: number, w: number, h: number): HTMLElement {
  const el = document.createElement(tag);
  el.getBoundingClientRect = (): DOMRect =>
    ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;
  return el;
}

function surface(): HTMLElement {
  const s = rectEl('div', 0, 0, W, H);
  document.body.appendChild(s);
  return s;
}

function anchor(name: AnchorName, child?: { x: number; y: number; w: number; h: number }): HTMLElement {
  const host = rectEl('div', 0, 0, 0, 0);
  host.setAttribute('data-anchor', name);
  if (child) host.appendChild(rectEl('div', child.x, child.y, child.w, child.h));
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('measureRadarInsets', () => {
  it('insets the right edge by the right rail, so the track runs inside it', () => {
    const s = surface();
    anchor('right-rail', { x: W - 48, y: 48, w: 48, h: H - 48 });
    const ins = measureRadarInsets(s);
    expect(ins.right).toBe(48);
  });

  it('no rail (hidden / not mounted) leaves the right edge alone', () => {
    const s = surface();
    anchor('right-rail');
    expect(measureRadarInsets(s).right).toBe(0);
  });

  it('keeps the radar off the left strip', () => {
    const s = surface();
    anchor('left-strip', { x: 0, y: 150, w: 44, h: 120 });
    expect(measureRadarInsets(s).exclusions).toContainEqual({ x: 0, y: 150, w: 44, h: 120 });
  });

  it('every non-overlay anchor keeps the radar clear (a new anchor cannot be missed)', () => {
    for (const name of ANCHOR_NAMES) {
      document.body.innerHTML = '';
      const s = surface();
      anchor(name, { x: 300, y: 100, w: 40, h: 30 });
      const ins = measureRadarInsets(s);
      const kept = ins.right > 0 || ins.exclusions.some((e) => e.x === 300 && e.y === 100);
      expect(kept, `anchor ${name}`).toBe(!OVERLAYS.includes(name));
    }
  });
});
