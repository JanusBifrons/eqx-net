import { describe, expect, it } from 'vitest';
import { STANCE_COLOUR } from '../components/contactRows.js';
import type { PanelData } from '../components/selectionPanelData.js';
import {
  GROUP_TAG_LIFT_PX, WORLD_TAG_GLIDE_MS, requestWorldTagGlide, setWorldTagAnchor, setWorldTagElement, setWorldTagHudInsets,
  updateWorldTag, worldTagAt, worldTagCentre, worldTagCentreAt, worldTagPos, worldTagText,
} from './worldTag.js';
import { EMPTY_RADAR_INSETS } from '../../shared-types/settings/radar.js';

const data = (extra: Partial<PanelData>): PanelData => ({ name: 'Vex', hpPct: 60, shieldPct: null, ...extra });

describe('worldTagText', () => {
  it('a ship: "Type · Name", stance word in the stance colour, hull bar', () => {
    const t = worldTagText(data({ stance: 'hostile' }), 'Fighter');
    expect(t).toEqual({ title: 'Fighter · Vex', owner: 'Hostile', ownerColor: STANCE_COLOUR.hostile, hullPct: 60 });
  });

  it('a type that repeats the name is dropped; an owner wins over the stance word', () => {
    const t = worldTagText(data({ name: 'Solar Array', owner: 'you', stance: 'friendly' }), 'Solar Array');
    expect(t.title).toBe('Solar Array');
    expect(t.owner).toBe('you');
    expect(t.ownerColor).toBe(STANCE_COLOUR.friendly);
  });

  it('no hull bar for a rock or a pending read; no owner line without owner or stance', () => {
    expect(worldTagText(data({ noHull: true }), undefined)).toEqual({ title: 'Vex' });
    expect(worldTagText(data({ pending: true }), undefined).hullPct).toBeUndefined();
  });
});

describe('worldTagPos', () => {
  it('rounds an on-screen anchor', () => {
    expect(worldTagPos({ focusScreenX: 10.4, focusScreenY: 20.6, focusOnScreen: true })).toBe(true);
    expect(worldTagAt).toEqual({ x: 10, y: 21 });
  });

  it('the group tag hangs a fixed lift above the selection centroid', () => {
    const fb = { focusScreenX: NaN, focusScreenY: NaN, focusOnScreen: false, selCentroidScreenX: 50.4, selCentroidScreenY: 200, selCentroidOnScreen: true };
    expect(worldTagPos(fb, 'centroid')).toBe(true);
    expect(worldTagAt).toEqual({ x: 50, y: 200 - GROUP_TAG_LIFT_PX });
    expect(worldTagPos({ ...fb, selCentroidOnScreen: false }, 'centroid')).toBe(false);
    expect(worldTagPos(fb, 'focus')).toBe(false);
  });

  it('hidden off screen or with nothing focused (NaN)', () => {
    expect(worldTagPos({ focusScreenX: 10, focusScreenY: 20, focusOnScreen: false })).toBe(false);
    expect(worldTagPos({ focusScreenX: NaN, focusScreenY: NaN, focusOnScreen: true })).toBe(false);
  });
});

describe('updateWorldTag', () => {
  /** A fake element counting style writes. */
  function fakeEl() {
    const writes: string[] = [];
    const style = {
      _t: '', _v: '',
      get transform() { return this._t; }, set transform(v: string) { writes.push(`t:${v}`); this._t = v; },
      get visibility() { return this._v; }, set visibility(v: string) { writes.push(`v:${v}`); this._v = v; },
    };
    return { el: { style } as unknown as HTMLElement, writes };
  }

  it('writes visibility and transform only when they change', () => {
    const { el, writes } = fakeEl();
    setWorldTagElement(el);
    writes.length = 0;
    const fb = { focusScreenX: 100, focusScreenY: 50, focusOnScreen: true };
    updateWorldTag(fb);
    expect(writes).toEqual(['v:visible', 't:translate(100px, 50px) translate(-50%, -100%)']);
    updateWorldTag({ ...fb, focusScreenX: 100.2 });
    expect(writes.length).toBe(2);
    updateWorldTag({ ...fb, focusOnScreen: false });
    expect(writes[2]).toBe('v:hidden');
    updateWorldTag({ ...fb, focusOnScreen: false });
    expect(writes.length).toBe(3);
    setWorldTagElement(null);
  });
});

describe('worldTagCentre', () => {
  it('the focus centre is the bracket top lowered by the radius; the centroid as is', () => {
    expect(worldTagCentre({ focusScreenX: 10, focusScreenY: 20, focusOnScreen: false, focusScreenDiam: 30 })).toBe(true);
    expect(worldTagCentreAt).toEqual({ x: 10, y: 35 });
    const fb = { focusScreenX: NaN, focusScreenY: NaN, focusOnScreen: false, selCentroidScreenX: -5, selCentroidScreenY: 7 };
    expect(worldTagCentre(fb, 'centroid')).toBe(true);
    expect(worldTagCentreAt).toEqual({ x: -5, y: 7 });
    expect(worldTagCentre(fb, 'focus')).toBe(false);
  });
});

describe('updateWorldTag off screen (S9 edge-stuck)', () => {
  function part() {
    return { style: {} as Record<string, string>, textContent: '' };
  }
  function edgeEl() {
    const parts: Record<string, ReturnType<typeof part>> = {
      'data-world-tag-edge': part(), 'data-world-tag-arrow': part(),
      'data-world-tag-dist': part(), 'data-world-tag-pointer': part(),
    };
    const el = {
      style: {} as Record<string, string>,
      dataset: {} as Record<string, string>,
      offsetWidth: 100,
      offsetHeight: 40,
      querySelector: (sel: string) => parts[sel.slice(1, -1)] ?? null,
    };
    return { el: el as unknown as HTMLElement, raw: el, parts };
  }
  // 800×400 screen, 1 world unit per px (viewHalf = 400 along the 800 px side).
  const W = 800;
  const H = 400;
  const off = { focusScreenX: 1200, focusScreenY: 190, focusScreenDiam: 20, focusOnScreen: false, viewX: 1000, viewY: 500, viewHalf: 400 };

  it('sticks to the edge toward the focus, arrow + distance shown, taps on, radar skip id returned', () => {
    const { el, raw, parts } = edgeEl();
    setWorldTagHudInsets(EMPTY_RADAR_INSETS);
    setWorldTagAnchor('focus', 'swarm-7');
    setWorldTagElement(el);
    expect(updateWorldTag(off, W, H)).toBe('swarm-7');
    expect(raw.style['visibility']).toBe('visible');
    expect(raw.style['pointerEvents']).toBe('auto');
    expect(parts['data-world-tag-edge']!.style['display']).toBe('flex');
    expect(parts['data-world-tag-pointer']!.style['display']).toBe('none');
    // Centre (1200, 200) is straight right of the screen centre (400, 200):
    // the tag's centre sits on the right track (800 - 50 half width - gap).
    expect(raw.style['transform']).toBe('translate(744px, 200px) translate(-50%, -50%)');
    expect(parts['data-world-tag-arrow']!.style['transform']).toBe('rotate(0deg)');
    expect(parts['data-world-tag-dist']!.textContent).toBe('800 m');
    // Back on screen: the pointer returns, taps off, no radar skip.
    expect(updateWorldTag({ ...off, focusScreenX: 300, focusOnScreen: true }, W, H)).toBeNull();
    expect(raw.style['pointerEvents']).toBe('none');
    expect(parts['data-world-tag-edge']!.style['display']).toBe('none');
    setWorldTagElement(null);
  });

  it('a group tag edge-sticks too but skips nothing on the radar', () => {
    const { el, raw } = edgeEl();
    setWorldTagAnchor('centroid', null);
    setWorldTagElement(el);
    const fb = { ...off, focusScreenX: NaN, selCentroidScreenX: 400, selCentroidScreenY: -600, selCentroidOnScreen: false };
    expect(updateWorldTag(fb, W, H)).toBeNull();
    expect(raw.style['transform']).toBe('translate(400px, 26px) translate(-50%, -50%)');
    setWorldTagElement(null);
    setWorldTagAnchor('focus', null);
  });

  it('a tap glides the camera to the anchor once, only while edge-stuck', () => {
    const { el } = edgeEl();
    setWorldTagAnchor('focus', 'p1');
    setWorldTagElement(el);
    const calls: number[][] = [];
    const cam = { glideCameraTo: (x: number, y: number, ms: number) => { calls.push([x, y, ms]); } };
    updateWorldTag(off, W, H, cam);
    expect(calls).toEqual([]);
    requestWorldTagGlide();
    updateWorldTag(off, W, H, cam);
    // Screen (1200, 200) = 800 px right of centre, 0 down ⇒ game (1800, 500).
    expect(calls).toEqual([[1800, 500, WORLD_TAG_GLIDE_MS]]);
    updateWorldTag(off, W, H, cam);
    expect(calls.length).toBe(1);
    requestWorldTagGlide();
    updateWorldTag({ ...off, focusScreenX: 300, focusOnScreen: true }, W, H, cam);
    expect(calls.length).toBe(1);
    setWorldTagElement(null);
  });
});
