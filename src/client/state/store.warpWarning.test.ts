import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from './store';

describe('UIStore — warpWarnings (wave-system Phase 5)', () => {
  beforeEach(() => {
    // Reset the field between tests.
    for (const w of [...useUIStore.getState().warpWarnings]) {
      useUIStore.getState().removeWarpWarning(w.id);
    }
  });

  it('starts empty', () => {
    expect(useUIStore.getState().warpWarnings).toEqual([]);
  });

  it('addWarpWarning appends + stamps observedAtMs', () => {
    useUIStore.getState().addWarpWarning({
      id: 'squad-0',
      label: 'Legionnaire',
      count: 8,
      countdownMs: 300_000,
    });
    const ws = useUIStore.getState().warpWarnings;
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({ id: 'squad-0', label: 'Legionnaire', count: 8, countdownMs: 300_000 });
    expect(typeof ws[0]!.observedAtMs).toBe('number');
  });

  it('addWarpWarning defaults relation to "hostile" when absent (R2.21)', () => {
    useUIStore.getState().addWarpWarning({ id: 'squad-0', label: 'Legionnaire', count: 8, countdownMs: 300_000 });
    expect(useUIStore.getState().warpWarnings[0]!.relation).toBe('hostile');
  });

  it('addWarpWarning preserves an explicit relation (R2.21)', () => {
    useUIStore.getState().addWarpWarning({ id: 'p1', label: 'Ace', count: 1, countdownMs: 60_000, relation: 'neutral' });
    expect(useUIStore.getState().warpWarnings[0]!.relation).toBe('neutral');
  });

  it('addWarpWarning with an existing id replaces it (no duplicate)', () => {
    const add = useUIStore.getState().addWarpWarning;
    add({ id: 'squad-0', label: 'Legionnaire', count: 8, countdownMs: 300_000 });
    add({ id: 'squad-0', label: 'Legionnaire', count: 6, countdownMs: 120_000 });
    const ws = useUIStore.getState().warpWarnings;
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({ count: 6, countdownMs: 120_000 });
  });

  it('tracks multiple distinct warnings', () => {
    const add = useUIStore.getState().addWarpWarning;
    add({ id: 'squad-0', label: 'Legionnaire', count: 8, countdownMs: 300_000 });
    add({ id: 'p1', label: 'Ace', count: 1, countdownMs: 300_000 });
    expect(useUIStore.getState().warpWarnings).toHaveLength(2);
  });

  it('removeWarpWarning drops by id; unknown id is a no-op', () => {
    const { addWarpWarning, removeWarpWarning } = useUIStore.getState();
    addWarpWarning({ id: 'squad-0', label: 'Legionnaire', count: 8, countdownMs: 300_000 });
    removeWarpWarning('nope');
    expect(useUIStore.getState().warpWarnings).toHaveLength(1);
    removeWarpWarning('squad-0');
    expect(useUIStore.getState().warpWarnings).toHaveLength(0);
  });

  it('stores no spatial fields (Zustand purity, invariant #2)', () => {
    useUIStore.getState().addWarpWarning({ id: 's', label: 'L', count: 8, countdownMs: 1 });
    const keys = Object.keys(useUIStore.getState().warpWarnings[0]!);
    for (const banned of ['x', 'y', 'vx', 'vy', 'angle', 'rotation', 'position', 'velocity']) {
      expect(keys).not.toContain(banned);
    }
  });
});
