/**
 * Build mode, the third control mode (owner 2026-11-20: "There's three modes.
 * Build. Command. Fly."). Entering Build (the switch, or picking a building)
 * lets go of the ship like Command and pulls the camera back. Confirm and
 * Cancel stay in Build; only the switch's Fly / Command leaves it, at the zoom
 * you had, and Fly takes back the ship flown before Build.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../ships/shipActionsClient.js', () => ({
  sendCommand: vi.fn(() => true),
  sendPilotShip: vi.fn(() => true),
}));

import { sendCommand, sendPilotShip } from '../ships/shipActionsClient.js';
import { selectControlMode, useUIStore } from '../state/store.js';
import {
  BUILD_VIEW_GLIDE_MS, BUILD_ZOOM_OUT, buildViewActive, leaveBuildMode, resetBuildModeView, scaleOfView, stepBuildModeView,
  takeBuildRestoreScale, type BuildViewSample,
} from './buildModeView.js';

const W = 915;
const H = 412;
const VIEW = { viewX: 100, viewY: -50, viewHalf: 915 / 2 }; // scale 1

function camera() {
  return { glideCameraTo: vi.fn(), selectFleetShips: vi.fn() };
}

/** One RAF frame, as gameRafLoop drives it. */
function frame(cam: ReturnType<typeof camera>, view: BuildViewSample | null = VIEW, ship: string | null = 'ship-1'): void {
  stepBuildModeView(useUIStore.getState().buildMode, view, ship, cam, W, H);
}

const mode = () => selectControlMode(useUIStore.getState());

describe('buildModeView: Build is the third control mode', () => {
  beforeEach(() => {
    resetBuildModeView();
    vi.mocked(sendCommand).mockClear();
    vi.mocked(sendPilotShip).mockClear();
    useUIStore.setState({ placementKind: null, buildMode: false, currentSectorKey: 'sol-prime' });
    useUIStore.getState().setPilotMode('pilot');
    useUIStore.getState().setSelection([], null, null);
  });

  it('picking a building in Fly enters Build: lets go of the ship and pulls the camera back', () => {
    const cam = camera();
    useUIStore.getState().setPlacementKind('turret');
    expect(mode()).toBe('build');
    frame(cam);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().pilotMode).toBe('spectator');
    expect(mode()).toBe('build');
    expect(buildViewActive()).toBe(true);
    expect(cam.glideCameraTo).toHaveBeenCalledWith(100, -50, BUILD_VIEW_GLIDE_MS, scaleOfView(VIEW.viewHalf, W, H) * BUILD_ZOOM_OUT);
    // Steady state: no further switch or glide.
    frame(cam);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(cam.glideCameraTo).toHaveBeenCalledTimes(1);
  });

  it('the switch\'s Build button (no building yet) enters Build the same way', () => {
    const cam = camera();
    useUIStore.getState().setBuildMode(true);
    frame(cam);
    expect(mode()).toBe('build');
    expect(useUIStore.getState().placementKind).toBeNull();
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(cam.glideCameraTo).toHaveBeenCalledTimes(1);
  });

  it('Confirm stays in Build, ready for the next building (no second hand-over or pull-back)', () => {
    const cam = camera();
    useUIStore.getState().setPlacementKind('turret');
    frame(cam);
    useUIStore.getState().setPlacementKind(null); // Confirm placed it
    frame(cam);
    expect(mode()).toBe('build');
    expect(buildViewActive()).toBe(true);
    expect(sendPilotShip).not.toHaveBeenCalled();
    useUIStore.getState().setPlacementKind('solar'); // the next one
    frame(cam);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(cam.glideCameraTo).toHaveBeenCalledTimes(1);
  });

  it('Cancel on a ghost drops the ghost and stays in Build', () => {
    const cam = camera();
    useUIStore.getState().setPlacementKind('turret');
    frame(cam);
    useUIStore.getState().setPlacementKind(null); // Cancel / Escape
    frame(cam);
    expect(useUIStore.getState().placementKind).toBeNull();
    expect(mode()).toBe('build');
    expect(sendPilotShip).not.toHaveBeenCalled();
    expect(cam.glideCameraTo).toHaveBeenCalledTimes(1);
  });

  it('leaving via Fly takes back the same ship at the saved zoom', () => {
    const cam = camera();
    useUIStore.getState().setPlacementKind('turret');
    frame(cam);
    frame(cam, { viewX: 300, viewY: 20, viewHalf: VIEW.viewHalf / BUILD_ZOOM_OUT });
    expect(leaveBuildMode('fly')).toBe(true);
    expect(sendPilotShip).toHaveBeenCalledWith('ship-1');
    expect(useUIStore.getState().placementKind).toBeNull();
    frame(cam);
    expect(cam.glideCameraTo).toHaveBeenLastCalledWith(300, 20, BUILD_VIEW_GLIDE_MS, 1);
    expect(buildViewActive()).toBe(false);
    // The pilot-swap glide that follows the fly-back ends at the saved zoom too (one-shot).
    expect(takeBuildRestoreScale()).toBe(1);
    expect(takeBuildRestoreScale()).toBe(0);
  });

  it('leaving via Command keeps the ship AI-flown and restores the zoom', () => {
    const cam = camera();
    useUIStore.getState().setPlacementKind('turret');
    frame(cam);
    expect(leaveBuildMode('command')).toBe(false);
    frame(cam);
    expect(mode()).toBe('command');
    expect(sendPilotShip).not.toHaveBeenCalled();
    expect(cam.glideCameraTo).toHaveBeenCalledTimes(2);
    expect(buildViewActive()).toBe(false);
    expect(takeBuildRestoreScale()).toBe(0);
  });

  it('Build entered from Command: Fly has no ship to take back (falls to the ship menu)', () => {
    useUIStore.getState().setPilotMode('spectator');
    const cam = camera();
    useUIStore.getState().setBuildMode(true);
    frame(cam);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(leaveBuildMode('fly')).toBe(false);
    expect(sendPilotShip).not.toHaveBeenCalled();
    expect(mode()).toBe('command');
  });

  it('flying a ship again (welcome) ends Build without a second fly-back', () => {
    const cam = camera();
    useUIStore.getState().setPlacementKind('turret');
    frame(cam);
    useUIStore.getState().setPilotMode('pilot');
    expect(mode()).toBe('fly');
    frame(cam);
    expect(sendPilotShip).not.toHaveBeenCalled();
    expect(buildViewActive()).toBe(false);
  });

  it('leaveBuildMode outside Build is a no-op', () => {
    expect(leaveBuildMode('fly')).toBe(false);
    expect(leaveBuildMode('command')).toBe(false);
    expect(sendPilotShip).not.toHaveBeenCalled();
    expect(mode()).toBe('fly');
  });

  it('waits for a camera reading before pulling back', () => {
    const cam = camera();
    useUIStore.getState().setPlacementKind('turret');
    frame(cam, null);
    expect(cam.glideCameraTo).not.toHaveBeenCalled();
    frame(cam);
    expect(cam.glideCameraTo).toHaveBeenCalledTimes(1);
  });

  // Stills review 2026-11-20 (`?room=sector`): Build is a Command view in every
  // room, with or without a sector key (the server hands the ship back there
  // too: pilotReclaimKeylessRoom.test.ts).
  it('in a room with no sector key, Build still lets go and Fly takes the ship back', () => {
    useUIStore.setState({ currentSectorKey: null });
    const cam = camera();
    useUIStore.getState().setPlacementKind('solar');
    frame(cam);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(leaveBuildMode('fly')).toBe(true);
    expect(sendPilotShip).toHaveBeenCalledWith('ship-1');
  });

  it('a wheel zoom or a dropped local ship id mid-build does not lose the fly-back', () => {
    const cam = camera();
    useUIStore.getState().setPlacementKind('solar');
    frame(cam);
    for (let i = 1; i <= 4; i++) frame(cam, { ...VIEW, viewHalf: VIEW.viewHalf * (1 + i) });
    frame(cam, VIEW, null); // the hull is parked: no local ship id
    expect(leaveBuildMode('fly')).toBe(true);
    expect(sendPilotShip).toHaveBeenCalledWith('ship-1');
  });

  it('entering Build from Command clears a carried-over ship selection', () => {
    const cam = camera();
    useUIStore.getState().setPilotMode('spectator'); // Command
    useUIStore.getState().setSelection(['ship-2', 'ship-3'], null, null);
    useUIStore.getState().setBuildMode(true);
    frame(cam);
    expect(cam.selectFleetShips).toHaveBeenCalledTimes(1);
    expect(cam.selectFleetShips).toHaveBeenCalledWith([]);
    frame(cam); // edge-triggered: not every frame
    expect(cam.selectFleetShips).toHaveBeenCalledTimes(1);
  });

  it('entering Build with no ship selection leaves the selection alone (a focused building stays)', () => {
    const cam = camera();
    useUIStore.getState().setSelection([], 'swarm-9', 'structure');
    useUIStore.getState().setBuildMode(true);
    frame(cam);
    expect(cam.selectFleetShips).not.toHaveBeenCalled();
  });
});
