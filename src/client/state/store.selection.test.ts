import { describe, it, expect, beforeEach } from 'vitest';
import { EMPTY_SELECTION, useUIStore } from './store.js';

/**
 * THE selection (RTS Part A: one selection concept): the store mirrors the
 * renderer's selection as ONE shape, the selected ship ids plus the focus
 * (the entity whose details panel shows). Ids only, no spatial data (#2).
 */
describe('store — selection', () => {
  beforeEach(() => {
    useUIStore.setState({ selection: EMPTY_SELECTION, fleetPick: null });
  });

  it('defaults to empty: no ships, no focus', () => {
    expect(useUIStore.getState().selection).toEqual({ ids: [], focusId: null, focusKind: null });
  });

  it('setSelection stores a copy of the ids and the focus in one write', () => {
    const ids = ['me', 'hull-1'];
    useUIStore.getState().setSelection(ids, 'hull-1', 'lingering');
    const sel = useUIStore.getState().selection;
    expect(sel.ids).toEqual(['me', 'hull-1']);
    expect(sel.ids).not.toBe(ids);
    expect(sel.focusId).toBe('hull-1');
    expect(sel.focusKind).toBe('lingering');
  });

  it('a focus with no ships selected (inspecting a drone) is the same shape', () => {
    useUIStore.getState().setSelection([], 'swarm-7', 'drone');
    expect(useUIStore.getState().selection).toEqual({ ids: [], focusId: 'swarm-7', focusKind: 'drone' });
  });

  it('clearing returns the shared empty selection and ends a fleet map pick', () => {
    useUIStore.getState().setSelection(['a'], 'a', 'lingering');
    useUIStore.getState().setFleetPick('patrol');
    useUIStore.getState().setSelection([], null, null);
    expect(useUIStore.getState().selection).toBe(EMPTY_SELECTION);
    expect(useUIStore.getState().fleetPick).toBeNull();
  });

  it('a null focus never keeps a kind', () => {
    useUIStore.getState().setSelection(['a'], null, 'ship');
    expect(useUIStore.getState().selection.focusKind).toBeNull();
  });
});
