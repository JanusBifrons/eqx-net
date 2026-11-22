/**
 * Building panels A5: opening a building's settings (the Details panel's
 * Settings section, UI plan U3-6) glides the camera once so the building sits
 * mid-way across the screen left of the panel — in Build
 * and Command only (in Fly the follow camera owns the view).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('../ships/shipActionsClient.js', () => ({ sendCommand: vi.fn(() => true), sendPilotShip: vi.fn(() => true) }));
vi.mock('../input/TouchInput', async (orig) => ({ ...(await orig<typeof import('../input/TouchInput')>()), isTouchDevice: () => false }));

import { useUIStore } from '../state/store.js';
import { setGameClient } from '../net/clientSingleton.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';
import { BUILD_VIEW_GLIDE_MS, resetBuildModeView, stepBuildModeView } from '../structures/buildModeView.js';
import { EQX_PANEL_SIZE } from '../../ui/index.js';
import { StructureSettings } from './StructureSettings.js';
import { panelNudgeX, rightPanelWidthPx } from './panelCameraNudge.js';

const W = 1024;
const H = 768;
const VIEW = { viewX: 0, viewY: 0, viewHalf: 256 }; // scale = (1024 / 2) / 256 = 2 px per unit
const BX = 100;
const BY = -40;

function seed(): void {
  setGameClient({
    mirror: {
      localPlayerId: 'me',
      structures: new Map([[9, { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0, owner: 'me', ownerName: 'Me', drawFull: false }]]),
      swarm: new Map([[9, { kind: 2, shipKind: 'turret', radius: 36, x: BX, y: BY }]]),
    },
  } as unknown as ColyseusGameClient);
}

function camera() {
  return { glideCameraTo: vi.fn(), selectFleetShips: vi.fn() };
}

const frame = (cam: ReturnType<typeof camera>): void =>
  stepBuildModeView(useUIStore.getState().buildMode, VIEW, 'ship-1', cam, W, H);

const open = (): void => { render(<StructureSettings entityId={9} />); };

describe('panelCameraNudge maths', () => {
  it('panel width follows the right dock: 380 desktop, 36% on touch, 300 floor', () => {
    expect(rightPanelWidthPx(EQX_PANEL_SIZE, 1024, false)).toBe(380);
    expect(rightPanelWidthPx(EQX_PANEL_SIZE, 800, true)).toBe(300);
    expect(rightPanelWidthPx(EQX_PANEL_SIZE, 600, true)).toBe(300);
    expect(rightPanelWidthPx(EQX_PANEL_SIZE, 1200, true)).toBe(380);
  });

  it('the right rail widens the covered strip; at 0 nothing moves', () => {
    expect(rightPanelWidthPx(EQX_PANEL_SIZE, 1024, false, 0)).toBe(380);
    expect(rightPanelWidthPx(EQX_PANEL_SIZE, 1024, false, 56)).toBe(436);
    expect(rightPanelWidthPx(EQX_PANEL_SIZE, 800, true, 48)).toBe(348);
    expect(panelNudgeX(100, rightPanelWidthPx(EQX_PANEL_SIZE, 1024, false, 56), 2)).toBe(209);
  });

  it('shifts the camera +X by half the panel, in world units', () => {
    expect(panelNudgeX(100, 360, 2)).toBe(190);
    expect(panelNudgeX(100, 360, 0.5)).toBe(460);
    expect(panelNudgeX(100, 360, 0)).toBe(100); // no camera reading yet
  });
});

describe('opening a building panel nudges the camera', () => {
  beforeEach(() => {
    resetBuildModeView();
    vi.stubGlobal('innerWidth', W);
    vi.stubGlobal('innerHeight', H);
    seed();
  });
  afterEach(() => { cleanup(); setGameClient(null); resetBuildModeView(); vi.unstubAllGlobals(); });

  it('in Build: one glide, building centred left of the panel, zoom kept', () => {
    useUIStore.setState({ buildMode: true, pilotMode: 'spectator' });
    const cam = camera();
    frame(cam); // Build's own pull-back
    cam.glideCameraTo.mockClear();
    open();
    frame(cam);
    frame(cam);
    expect(cam.glideCameraTo).toHaveBeenCalledTimes(1);
    expect(cam.glideCameraTo).toHaveBeenCalledWith(BX + 380 / 2 / 2, BY, BUILD_VIEW_GLIDE_MS);
  });

  it('in Command: the same one glide', () => {
    useUIStore.setState({ buildMode: false, pilotMode: 'spectator' });
    const cam = camera();
    open();
    frame(cam);
    frame(cam);
    expect(cam.glideCameraTo).toHaveBeenCalledTimes(1);
    expect(cam.glideCameraTo).toHaveBeenCalledWith(195, BY, BUILD_VIEW_GLIDE_MS);
  });

  it('in Fly: no glide (the follow camera owns the view)', () => {
    useUIStore.setState({ buildMode: false, pilotMode: 'pilot', pendingCommandStart: false });
    const cam = camera();
    open();
    frame(cam);
    expect(cam.glideCameraTo).not.toHaveBeenCalled();
  });

  it('upright (bottom sheet): no glide', () => {
    vi.stubGlobal('innerWidth', 412);
    vi.stubGlobal('innerHeight', 915);
    useUIStore.setState({ buildMode: false, pilotMode: 'spectator' });
    const cam = camera();
    open();
    frame(cam);
    expect(cam.glideCameraTo).not.toHaveBeenCalled();
  });
});
