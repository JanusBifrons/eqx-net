/**
 * Plan then Build: a place-once kind ends placing with its building still
 * planned, so Build and ✕ stay on the placing hexes. The Build panel must not
 * come back over them, or a touch player has no way to send the plan (#1391
 * CI: the placement-build tap timed out under the panel). Once the plan is
 * sent (or cancelled) the panel comes back for the next structure.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { BuildSidebarHost } from './BuildSidebarHost.js';
import { addPlannedPlacement, clearPlacementPlan } from '../structures/placementPlan.js';

const panelOpen = (): boolean => useUIStore.getState().rightPanel === 'build';

describe('BuildSidebarHost: placing ends with a building still planned', () => {
  beforeEach(() => {
    cleanup();
    clearPlacementPlan();
    useUIStore.setState({ phase: 'galaxy-map', isDead: false, placementKind: null, buildMode: true, fleetPick: null, rightPanel: null });
  });

  it('keeps the panel closed while the plan waits for Build, then reopens it once the plan is sent', () => {
    render(<BuildSidebarHost />);
    act(() => useUIStore.getState().setPlacementKind('solar'));
    act(() => {
      addPlannedPlacement('solar', 0, 0, 0, false, false);
      useUIStore.getState().setPlacementKind(null); // place-once: Place plans it and ends placing
    });
    expect(panelOpen()).toBe(false);
    act(() => clearPlacementPlan()); // Build sent it
    expect(panelOpen()).toBe(true);
  });

  it('still reopens at once when placing ends with nothing planned', () => {
    render(<BuildSidebarHost />);
    act(() => useUIStore.getState().setPlacementKind('solar'));
    act(() => useUIStore.getState().setPlacementKind(null));
    expect(panelOpen()).toBe(true);
  });
});
