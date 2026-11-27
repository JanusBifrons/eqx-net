import { describe, expect, it } from 'vitest';
import { STANCE_COLOUR } from '../components/contactRows.js';
import type { PanelData } from '../components/selectionPanelData.js';
import { setWorldTagElement, updateWorldTag, worldTagAt, worldTagPos, worldTagText } from './worldTag.js';

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
