/**
 * RTS slice 15a: the main thread turns fleet status rows into the renderer's
 * compact overlay model and pushes it only when the status version moves.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IRenderer } from '@core/contracts/IRenderer';
import { applyFleetStatus, getFleetStatus, getFleetStatusVersion, resetFleetStatus, type FleetStatusUpdate } from './fleetStatus.js';
import { buildFleetOverlayModel, overlayShipFor, pushFleetOverlayModelIfChanged } from './fleetOverlayModel.js';

const row = (id: string, over: Partial<FleetStatusUpdate> = {}): FleetStatusUpdate => ({
  id, mode: 'defend', stance: 'defensive', activity: 'guarding', targetId: null, hullPct: 100, ...over,
});

describe('fleetStatus slice-15a fields', () => {
  beforeEach(() => resetFleetStatus());
  it('stores orderX / orderY / route / escortId', () => {
    applyFleetStatus([row('a', { orderKind: 'move', orderX: 5, orderY: 6, route: [[1, 2]], escortId: 'b' })]);
    expect(getFleetStatus('a')).toMatchObject({ orderX: 5, orderY: 6, route: [[1, 2]], escortId: 'b' });
  });
  it('an equal route in a new array does not bump the version; a changed one does', () => {
    applyFleetStatus([row('a', { route: [[1, 2], [3, 4]] })]);
    const v = getFleetStatusVersion();
    applyFleetStatus([row('a', { route: [[1, 2], [3, 4]] })]);
    expect(getFleetStatusVersion()).toBe(v);
    applyFleetStatus([row('a', { route: [[1, 2], [3, 5]] })]);
    expect(getFleetStatusVersion()).toBe(v + 1);
    applyFleetStatus([row('a', { route: [[1, 2], [3, 5]], orderX: 1 })]);
    expect(getFleetStatusVersion()).toBe(v + 2);
  });
});

describe('overlayShipFor', () => {
  it('maps squad + move destination', () => {
    expect(overlayShipFor('a', row('a', { squadId: 'sq', orderKind: 'move', orderX: 1, orderY: 2 })))
      .toEqual({ id: 'a', squadId: 'sq', orderKind: 'move', destX: 1, destY: 2 });
  });
  it('maps an attack order to its target', () => {
    expect(overlayShipFor('a', row('a', { orderKind: 'attack', targetId: 'swarm-3' })))
      .toEqual({ id: 'a', squadId: null, orderKind: 'attack', targetId: 'swarm-3' });
  });
  it('a hunt target without an attack order is not an order line', () => {
    expect(overlayShipFor('a', row('a', { mode: 'hunt', targetId: 'swarm-3' }))).toEqual({ id: 'a', squadId: null, orderKind: null });
  });
  it('patrol route and escort show only while no direct order runs', () => {
    expect(overlayShipFor('a', row('a', { mode: 'patrol', route: [[0, 0], [1, 1]] })).route).toEqual([[0, 0], [1, 1]]);
    expect(overlayShipFor('a', row('a', { mode: 'escort', targetId: 'b' })).escortId).toBe('b');
    expect(overlayShipFor('a', row('a', { escortId: 'c' })).escortId).toBe('c');
    const ordered = overlayShipFor('a', row('a', { mode: 'patrol', route: [[0, 0], [1, 1]], orderKind: 'move', orderX: 9, orderY: 9 }));
    expect(ordered.route).toBeUndefined();
  });
  it('the model is structured-cloneable', () => {
    const s = overlayShipFor('a', row('a', { route: [[0, 0], [1, 1]] }));
    expect(structuredClone(s)).toEqual(s);
  });
});

describe('pushFleetOverlayModelIfChanged', () => {
  beforeEach(() => resetFleetStatus());
  it('pushes once per version change and never on unchanged frames', () => {
    const setFleetOverlayModel = vi.fn();
    const r = { setFleetOverlayModel } as unknown as IRenderer;
    let last = getFleetStatusVersion();
    last = pushFleetOverlayModelIfChanged(r, last);
    expect(setFleetOverlayModel).not.toHaveBeenCalled();
    applyFleetStatus([row('a', { squadId: 'sq' }), row('b', { squadId: 'sq' })]);
    last = pushFleetOverlayModelIfChanged(r, last);
    last = pushFleetOverlayModelIfChanged(r, last);
    expect(setFleetOverlayModel).toHaveBeenCalledTimes(1);
    expect(setFleetOverlayModel.mock.calls[0]![0]).toEqual(buildFleetOverlayModel());
    expect(buildFleetOverlayModel().ships.map((s) => s.squadId)).toEqual(['sq', 'sq']);
    resetFleetStatus();
    pushFleetOverlayModelIfChanged(r, last);
    expect(setFleetOverlayModel).toHaveBeenCalledTimes(2);
    expect(setFleetOverlayModel.mock.calls[1]![0]).toEqual({ ships: [] });
  });
});
