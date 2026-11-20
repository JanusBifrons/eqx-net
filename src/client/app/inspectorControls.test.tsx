import { afterEach, describe, expect, it } from 'vitest';
import { hudControlsFor } from './inspectorPlacement';

/** A positioned element (jsdom has no layout, so the rect is stubbed). */
function box(parent: HTMLElement, tag: string, cls: string, r: [number, number, number, number]): HTMLElement {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.getBoundingClientRect = () => ({ left: r[0], top: r[1], right: r[2], bottom: r[3], width: r[2] - r[0], height: r[3] - r[1], x: r[0], y: r[1], toJSON: () => ({}) });
  parent.appendChild(el);
  return el;
}

function dial(closed: boolean): void {
  const root = document.createElement('div');
  root.dataset['testid'] = 'speed-dial';
  document.body.appendChild(root);
  box(root, 'button', 'MuiSpeedDial-fab', [1080, 400, 1124, 444]);
  const list = box(root, 'div', closed ? 'MuiSpeedDial-actions MuiSpeedDial-actionsClosed' : 'MuiSpeedDial-actions', [0, 0, 0, 0]);
  const action = box(list, 'span', 'MuiSpeedDialAction-staticTooltip', [0, 0, 0, 0]);
  box(action, 'span', 'MuiSpeedDialAction-staticTooltipLabel', [790, 150, 905, 180]);
  box(action, 'button', 'MuiSpeedDialAction-fab', [910, 145, 960, 185]);
}

// Live still: the inspector covered the Build menu's label pills because only
// `[data-hud-exclusion]` was measured; the dial's buttons and pills count too.
describe('hudControlsFor', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('measures the open speed dial: main button, action buttons and label pills', () => {
    const stick = box(document.body, 'div', '', [16, 300, 116, 400]);
    stick.setAttribute('data-hud-exclusion', '');
    dial(false);
    const c = hudControlsFor('a', 1132, 473);
    const rects: number[][] = [];
    for (let i = 0; i < c.n; i++) rects.push(Array.from(c.r.subarray(i * 4, i * 4 + 4)));
    expect(rects).toContainEqual([16, 300, 116, 400]);
    expect(rects).toContainEqual([1080, 400, 1124, 444]);
    expect(rects).toContainEqual([790, 150, 905, 180]);
    expect(rects).toContainEqual([910, 145, 960, 185]);
  });

  it('skips the parked (closed) action list and re-measures when the dial opens', () => {
    dial(true);
    expect(hudControlsFor('b', 1132, 473).n).toBe(1); // the main button only
    document.querySelector('.MuiSpeedDial-actions')!.classList.remove('MuiSpeedDial-actionsClosed');
    expect(hudControlsFor('b', 1132, 473).n).toBe(3); // same key, dial opened
  });
});
