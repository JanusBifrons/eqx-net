/**
 * Build mode's view (owner design 2026-11-20): picking a building switches to
 * the Command view and pulls the camera back; leaving restores the view and
 * zoom you had.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../ships/shipActionsClient.js', () => ({
  sendCommand: vi.fn(() => true),
  sendPilotShip: vi.fn(() => true),
}));

import { sendCommand, sendPilotShip } from '../ships/shipActionsClient.js';
import { selectControlMode, useUIStore } from '../state/store.js';
import {
  BUILD_VIEW_GLIDE_MS, BUILD_ZOOM_OUT, buildViewActive, resetBuildModeView, scaleOfView, stepBuildModeView, takeBuildRestoreScale,
} from './buildModeView.js';

const W = 915;
const H = 412;
const VIEW = { viewX: 100, viewY: -50, viewHalf: 915 / 2 }; // scale 1

function camera() {
  return { glideCameraTo: vi.fn() };
}

describe('buildModeView', () => {
  beforeEach(() => {
    resetBuildModeView();
    vi.mocked(sendCommand).mockClear();
    vi.mocked(sendPilotShip).mockClear();
    useUIStore.getState().setPilotMode('pilot');
    // A galaxy sector: the server can hand a parked hull back (it keeps a roster).
    useUIStore.setState({ currentSectorKey: 'sol-prime' });
  });

  it('entering placement from Fly switches to Command and pulls the camera back', () => {
    const cam = camera();
    stepBuildModeView('turret', VIEW, 'ship-1', cam, W, H);
    expect(selectControlMode(useUIStore.getState())).toBe('command');
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(buildViewActive()).toBe(true);
    expect(cam.glideCameraTo).toHaveBeenCalledWith(100, -50, BUILD_VIEW_GLIDE_MS, scaleOfView(VIEW.viewHalf, W, H) * BUILD_ZOOM_OUT);
    // Steady state: no further switch or glide.
    stepBuildModeView('turret', VIEW, 'ship-1', cam, W, H);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(cam.glideCameraTo).toHaveBeenCalledTimes(1);
  });

  it('leaving placement restores Fly on the same ship and the saved zoom', () => {
    const cam = camera();
    stepBuildModeView('turret', VIEW, 'ship-1', cam, W, H);
    stepBuildModeView('turret', { viewX: 300, viewY: 20, viewHalf: VIEW.viewHalf / BUILD_ZOOM_OUT }, 'ship-1', cam, W, H);
    stepBuildModeView(null, VIEW, 'ship-1', cam, W, H);
    expect(sendPilotShip).toHaveBeenCalledWith('ship-1');
    expect(cam.glideCameraTo).toHaveBeenLastCalledWith(300, 20, BUILD_VIEW_GLIDE_MS, 1);
    expect(buildViewActive()).toBe(false);
    // The pilot-swap glide that follows the fly-back ends at the saved zoom too (one-shot).
    expect(takeBuildRestoreScale()).toBe(1);
    expect(takeBuildRestoreScale()).toBe(0);
  });

  it('waits for a camera reading before pulling back', () => {
    const cam = camera();
    stepBuildModeView('turret', null, 'ship-1', cam, W, H);
    expect(cam.glideCameraTo).not.toHaveBeenCalled();
    stepBuildModeView('turret', VIEW, 'ship-1', cam, W, H);
    expect(cam.glideCameraTo).toHaveBeenCalledTimes(1);
  });

  it('starting in Command stays in Command (no fly-back)', () => {
    useUIStore.getState().setPilotMode('spectator');
    const cam = camera();
    stepBuildModeView('turret', VIEW, 'ship-1', cam, W, H);
    expect(sendCommand).not.toHaveBeenCalled();
    stepBuildModeView(null, VIEW, 'ship-1', cam, W, H);
    expect(sendPilotShip).not.toHaveBeenCalled();
    expect(takeBuildRestoreScale()).toBe(0);
    expect(selectControlMode(useUIStore.getState())).toBe('command');
  });

  it('does not take a ship back if the player already flies again', () => {
    const cam = camera();
    stepBuildModeView('turret', VIEW, 'ship-1', cam, W, H);
    useUIStore.getState().setPilotMode('pilot');
    stepBuildModeView(null, VIEW, 'ship-1', cam, W, H);
    expect(sendPilotShip).not.toHaveBeenCalled();
  });

  // Stills review 2026-11-20 (`?room=sector`): Cancel left the player in
  // Command with no joystick. A room with no sector key keeps no roster, so
  // the server ignores `pilot_ship` (`reclaimLingeringHull` returns early):
  // the ship let go of could never be flown again. Build mode there keeps
  // the ship (stays in Fly), so Cancel / Confirm always end flying.
  it('in a room with no sector key, build mode keeps flying the ship (no strand in Command)', () => {
    useUIStore.setState({ currentSectorKey: null });
    const cam = camera();
    stepBuildModeView('solar', VIEW, 'ship-1', cam, W, H);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(selectControlMode(useUIStore.getState())).toBe('fly');
    // Still a build view: the camera pulls back, and comes back on exit.
    expect(cam.glideCameraTo).toHaveBeenCalledTimes(1);
    stepBuildModeView(null, VIEW, 'ship-1', cam, W, H);
    expect(sendPilotShip).not.toHaveBeenCalled();
    expect(cam.glideCameraTo).toHaveBeenCalledTimes(2);
    expect(selectControlMode(useUIStore.getState())).toBe('fly');
  });

  it('a dial toggle or wheel zoom mid-build does not lose the fly-back', () => {
    const cam = camera();
    stepBuildModeView('solar', VIEW, 'ship-1', cam, W, H);
    // Wheel zoom-out: only the camera reading changes, frame after frame.
    for (let i = 1; i <= 4; i++) stepBuildModeView('solar', { ...VIEW, viewHalf: VIEW.viewHalf * (1 + i) }, 'ship-1', cam, W, H);
    // The local ship id drops while in Command (the hull is parked).
    stepBuildModeView('solar', VIEW, null, cam, W, H);
    stepBuildModeView(null, VIEW, null, cam, W, H);
    expect(sendPilotShip).toHaveBeenCalledWith('ship-1');
  });
});
