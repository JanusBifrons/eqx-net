import { describe, it, expect, beforeEach } from 'vitest';
import { selectControlMode, useUIStore } from './store.js';

/**
 * Phase 4 WS-0 lock — `pilotMode` is a discrete, purity-clean enum flag
 * ('pilot' | 'spectator'). It carries NO spatial data (the free-roam camera
 * pose lives in the render mirror, never the store — Invariant #2). WS-0 lands
 * only the flag + setter with a `pilot` default; the death→spectate transition,
 * the free-roam camera/input, and the speed-dial toggle are WS-A1.
 */
describe('store — pilotMode (Phase 4 WS-0)', () => {
  beforeEach(() => {
    useUIStore.setState({ pilotMode: 'pilot' });
  });

  it('defaults to "pilot"', () => {
    expect(useUIStore.getState().pilotMode).toBe('pilot');
  });

  it('setPilotMode round-trips pilot↔spectator without touching isDead', () => {
    useUIStore.setState({ isDead: false });
    useUIStore.getState().setPilotMode('spectator');
    expect(useUIStore.getState().pilotMode).toBe('spectator');
    expect(useUIStore.getState().isDead).toBe(false);
    useUIStore.getState().setPilotMode('pilot');
    expect(useUIStore.getState().pilotMode).toBe('pilot');
  });
});

/**
 * RTS slice 10 — `controlMode` ('fly' | 'command') is the player-facing view of
 * the ONE stored `pilotMode` field (a selector, never a second field). Before a
 * join the store says `fly` (the ship-bound readiness gate needs it); the
 * command default is decided by the join (`startMode`) and the server's
 * `control_mode` flip, see `app/startMode.test.ts`.
 */
describe('store — controlMode view (RTS slice 10)', () => {
  it('maps pilot → fly and spectator → command', () => {
    expect(selectControlMode({ pilotMode: 'pilot' })).toBe('fly');
    expect(selectControlMode({ pilotMode: 'spectator' })).toBe('command');
  });

  it('a fresh store (pre-join) reads fly; entering command view reads command', () => {
    useUIStore.setState({ pilotMode: 'pilot' });
    expect(selectControlMode(useUIStore.getState())).toBe('fly');
    useUIStore.getState().setPilotMode('spectator');
    expect(selectControlMode(useUIStore.getState())).toBe('command');
  });
});

/**
 * Owner smoke (Helm during loading): a galaxy join asks the server to land in
 * Command view (`startMode: 'command'`), but the store holds `pilot` until the
 * server's `control_mode` flip at arrival, so the Helm read Fly the whole load.
 * The join records the requested start (`pendingCommandStart`); the view reads
 * Command from then on, and the stored `pilotMode` stays `pilot` for the
 * ship-bound readiness gate.
 */
describe('store — a command-view join reads Command before the server flip', () => {
  beforeEach(() => {
    useUIStore.setState({ pilotMode: 'pilot', buildMode: false, pendingCommandStart: false });
  });

  it('reads command while the join waits for the arrival flip', () => {
    useUIStore.getState().setPendingCommandStart(true);
    expect(useUIStore.getState().pilotMode).toBe('pilot');
    expect(selectControlMode(useUIStore.getState())).toBe('command');
  });

  it('any pilotMode write settles it (the server flip, a pilot swap, teardown)', () => {
    useUIStore.getState().setPendingCommandStart(true);
    useUIStore.getState().setPilotMode('spectator');
    expect(useUIStore.getState().pendingCommandStart).toBe(false);
    useUIStore.getState().setPendingCommandStart(true);
    useUIStore.getState().setPilotMode('pilot');
    expect(useUIStore.getState().pendingCommandStart).toBe(false);
    expect(selectControlMode(useUIStore.getState())).toBe('fly');
  });

  it('Build still wins over a pending command start', () => {
    useUIStore.setState({ pendingCommandStart: true, buildMode: true });
    expect(selectControlMode(useUIStore.getState())).toBe('build');
  });
});
