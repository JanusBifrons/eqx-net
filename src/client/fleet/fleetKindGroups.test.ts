import { describe, expect, it, vi } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { getShipKind, SHIP_KINDS } from '@shared-types/shipKinds';
import { SIZE_CLASSES, sizeClassOf } from '@shared-types/shipScale/tuning';
import { capKindGroups, groupMirrorSelection, groupSelectionByKind, keepOnlyKind, type KindGroup } from './fleetView.js';

const kindIds = Object.keys(SHIP_KINDS);
const ofClass = (c: string): string[] => kindIds.filter((k) => sizeClassOf(getShipKind(k)) === c);

describe('groupSelectionByKind (selection HUD S5a)', () => {
  it('groups ids by kind with display name and count, ids in selection order', () => {
    const kinds: Record<string, string> = { a: 'fighter', b: 'fighter', c: 'battleship', d: 'fighter' };
    const groups = groupSelectionByKind(['a', 'b', 'c', 'd'], (id) => kinds[id]);
    const fighters = groups.find((g) => g.kind === 'fighter')!;
    expect(fighters.ids).toEqual(['a', 'b', 'd']);
    expect(fighters.count).toBe(3);
    expect(fighters.displayName).toBe(getShipKind('fighter').displayName);
    expect(groups.find((g) => g.kind === 'battleship')!.count).toBe(1);
  });

  it('puts the largest size class first, unknown kinds last', () => {
    const capital = ofClass('capital')[0]!;
    const fighter = ofClass('fighter')[0]!;
    const kinds: Record<string, string | undefined> = { f1: fighter, f2: fighter, f3: fighter, c1: capital, u: undefined };
    const groups = groupSelectionByKind(['u', 'f1', 'f2', 'f3', 'c1'], (id) => kinds[id]);
    expect(groups.map((g) => g.kind)).toEqual([capital, fighter, '']);
    expect(groups[2]!.displayName).toBe('Ship');
  });

  it('orders by size class across every class present in the catalogue', () => {
    const picks = SIZE_CLASSES.map((c) => ofClass(c)[0]).filter((k): k is string => k !== undefined);
    const groups = groupSelectionByKind(picks.map((_, i) => `s${i}`), (id) => picks[Number(id.slice(1))]);
    const ranks = groups.map((g) => SIZE_CLASSES.indexOf(sizeClassOf(getShipKind(g.kind))));
    expect(ranks).toEqual([...ranks].sort((x, y) => y - x));
  });

  it('within a class: count desc, then name', () => {
    const fighters = ofClass('fighter').slice(0, 3);
    if (fighters.length < 3) return;
    const [x, y, z] = fighters as [string, string, string];
    const kinds: Record<string, string> = { a: x, b: y, c: y, d: z };
    const groups = groupSelectionByKind(['a', 'b', 'c', 'd'], (id) => kinds[id]);
    expect(groups[0]!.kind).toBe(y);
    const rest = groups.slice(1).map((g) => g.displayName);
    expect(rest).toEqual([...rest].sort((p, q) => p.localeCompare(q)));
  });

  it('averages hull over known hulls only; null when none known', () => {
    const hull: Record<string, number | null> = { a: 1, b: 0.5, c: null };
    const [g] = groupSelectionByKind(['a', 'b', 'c'], () => 'fighter', (id) => hull[id] ?? null);
    expect(g!.avgHullFrac).toBeCloseTo(0.75);
    const [n] = groupSelectionByKind(['c'], () => 'fighter', () => null);
    expect(n!.avgHullFrac).toBeNull();
  });

  it('reads kind and hull from the render mirror', () => {
    const ships = new Map<string, unknown>([
      ['a', { kind: 'fighter', health: 50, maxHealth: 100 }],
      ['b', { kind: 'fighter', health: 100, maxHealth: 100 }],
    ]);
    const mirror = { ships } as unknown as RenderMirror;
    const [g] = groupMirrorSelection(mirror, ['a', 'b']);
    expect(g!.kind).toBe('fighter');
    expect(g!.avgHullFrac).toBeCloseTo(0.75);
    expect(groupMirrorSelection(null, ['a'])[0]!.kind).toBe('');
  });
});

describe('capKindGroups', () => {
  const g = (kind: string, count: number): KindGroup => ({ kind, displayName: kind, ids: [], count, avgHullFrac: null });

  it('shows all groups up to the cap', () => {
    const groups = [g('a', 1), g('b', 2), g('c', 1), g('d', 1), g('e', 1)];
    expect(capKindGroups(groups)).toEqual({ shown: groups, overflowKinds: [], overflowCount: 0 });
  });

  it('past the cap the last slot becomes overflow with the remaining ship count', () => {
    const groups = [g('a', 1), g('b', 2), g('c', 1), g('d', 1), g('e', 3), g('f', 4)];
    const r = capKindGroups(groups);
    expect(r.shown.map((x) => x.kind)).toEqual(['a', 'b', 'c', 'd']);
    expect(r.overflowKinds.map((x) => x.kind)).toEqual(['e', 'f']);
    expect(r.overflowCount).toBe(7);
  });

  it('honours a custom max', () => {
    const r = capKindGroups([g('a', 1), g('b', 1), g('c', 2)], 2);
    expect(r.shown.map((x) => x.kind)).toEqual(['a']);
    expect(r.overflowCount).toBe(3);
  });
});

describe('keepOnlyKind', () => {
  it('selects exactly the group ids through selectFleetShips', () => {
    const view = { selectFleetShips: vi.fn() };
    keepOnlyKind(view, { ids: ['x', 'y'] });
    expect(view.selectFleetShips).toHaveBeenCalledWith(['x', 'y']);
  });
});
