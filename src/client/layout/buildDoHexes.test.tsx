/**
 * Selection HUD S4: the Build do-hexes as data (`buildDoHexes.tsx`). The own
 * structure's hexes (Upgrade, Demolish, Power, More; only what exists today),
 * the predicate that shows them, and the strip coverage (one place per action).
 */
import { describe, expect, it, vi } from 'vitest';
import { buildHexCovers, buildingDoHexes, buildingHexesShow, kindWord, placingDoHexes, type BuildingDoHexOptions } from './buildDoHexes';
import { DO_HEX_MAX } from './doHexLayout';
import type { PanelData } from '../components/selectionPanelData';
import type { StripAction } from './stripActions';

const power = (value: 'on' | 'off', onPick = vi.fn()): StripAction => ({
  kind: 'flyout', key: 'power', value, options: [], onPick, tooltip: 'Power', testId: 'left-strip-power',
});

function opts(over: Partial<BuildingDoHexOptions> = {}): BuildingDoHexOptions {
  return {
    building: [], manage: { canUpgrade: true, level: 2, upgradeMinerals: 40, isDeconstructing: false },
    upgrade: vi.fn(), demolishHold: vi.fn(), demolishHolding: false, stopDemolish: vi.fn(), openMore: vi.fn(),
    ...over,
  };
}

describe('buildingDoHexes', () => {
  it('Upgrade under the thumb, then Demolish, Power, More', () => {
    const hexes = buildingDoHexes(opts({ building: [power('on')] }));
    expect(hexes.map((h) => h.testId)).toEqual(['do-hex-upgrade', 'do-hex-demolish', 'do-hex-power', 'do-hex-more']);
    expect(hexes[0]).toMatchObject({ role: 'main', disabled: false, word: 'Upgrade', state: 'lv2' });
    expect(hexes[0]?.tooltip).toMatch(/Lv 3: 40 minerals/);
  });

  it('Upgrade calls the existing send once; disabled when it cannot upgrade', () => {
    const o = opts();
    buildingDoHexes(o)[0]?.onPress();
    expect(o.upgrade).toHaveBeenCalledTimes(1);
    const off = opts({ manage: { canUpgrade: false } });
    const up = buildingDoHexes(off)[0];
    expect(up).toMatchObject({ disabled: true, state: 'none' });
    up?.onPress();
    expect(off.upgrade).not.toHaveBeenCalled();
  });

  it('Demolish is a hold; a running deconstruction is Stop, one tap', () => {
    const o = opts();
    const d = buildingDoHexes(o)[1];
    expect(d).toMatchObject({ word: 'Demolish', state: 'idle', tone: 'danger' });
    d?.onHold?.(true);
    expect(o.demolishHold).toHaveBeenCalledWith(true);
    expect(buildingDoHexes(opts({ demolishHolding: true }))[1]).toMatchObject({ word: 'Hold…', lit: true, state: 'holding' });
    const run = opts({ manage: { canUpgrade: false, isDeconstructing: true } });
    const stop = buildingDoHexes(run)[1];
    expect(stop).toMatchObject({ word: 'Stop', state: 'running' });
    expect(stop?.onHold).toBeUndefined();
    stop?.onPress();
    expect(run.stopDemolish).toHaveBeenCalledTimes(1);
  });

  it('Power flips through the builder\'s own pick; absent for a kind without a switch', () => {
    const onPick = vi.fn();
    const p = buildingDoHexes(opts({ building: [power('on', onPick)] })).find((h) => h.key === 'power');
    expect(p).toMatchObject({ word: 'Power on', state: 'on' });
    p?.onPress();
    expect(onPick).toHaveBeenCalledWith('off');
    const offPick = vi.fn();
    buildingDoHexes(opts({ building: [power('off', offPick)] })).find((h) => h.key === 'power')?.onPress();
    expect(offPick).toHaveBeenCalledWith('on');
    expect(buildingDoHexes(opts()).some((h) => h.key === 'power')).toBe(false);
  });

  it('before the manage data is read: More only (plus Power); More opens Details', () => {
    const o = opts({ manage: null });
    const hexes = buildingDoHexes(o);
    expect(hexes.map((h) => h.testId)).toEqual(['do-hex-more']);
    hexes[0]?.onPress();
    expect(o.openMore).toHaveBeenCalledTimes(1);
  });
});

describe('kindWord', () => {
  it('the kind\'s first word when it fits, else "Build"', () => {
    expect(kindWord('capital')).toBe('Capital');
    expect(kindWord('solar')).toBe('Solar');
    expect(kindWord('not-a-kind')).toBe('Build');
    expect(kindWord(undefined)).toBe('Build');
  });
});

describe('buildingHexesShow', () => {
  const d = (over: Partial<PanelData>): PanelData =>
    ({ name: 'Turret', hpPct: 100, shieldPct: null, entityId: 9, isStructure: true, isOwn: true, ...over }) as PanelData;
  it('Build (manage) with your own structure only', () => {
    expect(buildingHexesShow(d({}), true)).toBe(true);
    expect(buildingHexesShow(d({}), false)).toBe(false);
    expect(buildingHexesShow(d({ isOwn: false }), true)).toBe(false);
    expect(buildingHexesShow(d({ isStructure: false }), true)).toBe(false);
    expect(buildingHexesShow(null, true)).toBe(false);
  });
});

describe('buildHexCovers', () => {
  const b = (key: string, testId: string): StripAction => ({ kind: 'button', key, testId, icon: 'details', tooltip: '', onPress: () => {} });
  const sep: StripAction = { kind: 'separator', key: 's' };
  it('placing and route picks carry every tool', () => {
    expect(buildHexCovers('placing', b('place', 'placement-confirm'), false)).toBe(true);
    expect(buildHexCovers('route', b('route-cancel', 'left-strip-route-cancel'), false)).toBe(true);
    expect(buildHexCovers('placing', sep, false)).toBe(true);
    // Plan then Build: Build (n) stays on the left strip while placing.
    expect(buildHexCovers('placing', b('build', 'placement-build'), false)).toBe(true); // owner 2026-11-27: Build is a hex too
  });
  it('the own-structure set carries Power and Details only, and only while it shows', () => {
    expect(buildHexCovers('build', power('on'), true)).toBe(true);
    expect(buildHexCovers('build', b('details', 'left-strip-details'), true)).toBe(true);
    expect(buildHexCovers('build', b('details', 'left-strip-details'), false)).toBe(false);
    expect(buildHexCovers('build', b('loot', 'cargo-open-toggle'), true)).toBe(false);
    expect(buildHexCovers('build', sep, true)).toBe(false);
  });
});

describe('placingDoHexes', () => {
  const btn = (key: string, extra: Partial<StripAction> = {}): StripAction =>
    ({ kind: 'button', key, testId: `placement-${key}`, icon: 'details', tooltip: key, onPress: () => {}, ...extra }) as StripAction;
  const kind: StripAction = { kind: 'identity', key: 'kind', icon: 'structure', tooltip: 'Solar', state: 'solar', testId: 'placement-kind', health: 'ok' } as StripAction;
  it('Build is a hex with the planned count as its badge', () => {
    const b = placingDoHexes([btn('place'), kind, btn('build', { tooltip: 'Build (4)', state: '4' }), btn('cancel')]).find((h) => h.key === 'build');
    expect(b).toMatchObject({ testId: 'placement-build', word: 'Build', badge: 4, tooltip: 'Build (4)' });
  });
  it('never more than the grid holds: Mirror, then Rotate, then the building go first; never Place, Build or Cancel', () => {
    const all = [kind, btn('place'), btn('rotate'), btn('mirror'), btn('gate'), btn('build', { state: '3' }), btn('cancel')];
    const keys = placingDoHexes(all).map((h) => h.key);
    expect(keys.length).toBe(DO_HEX_MAX);
    expect(keys).toEqual(['place', 'rotate', 'kind', 'gate', 'build', 'cancel']);
  });
});
