/**
 * Building panels A5: opening a building's side panel glides the camera once
 * so the building sits mid-way across the screen left of the panel — in Build
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
import { SETTINGS_PANEL_SIZE, StructureSettingsModal } from './StructureSettingsModal.js';
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

const open = (): void => { render(<StructureSettingsModal open entityId={9} title="Turret" onClose={() => {}} />); };

describe('panelCameraNudge maths', () => {
  it('panel width follows the right dock: 360 desktop, 40% on touch, 280 floor', () => {
    expect(rightPanelWidthPx(SETTINGS_PANEL_SIZE, 1024, false)).toBe(360);
    expect(rightPanelWidthPx(SETTINGS_PANEL_SIZE, 800, true)).toBe(320);
    expect(rightPanelWidthPx(SETTINGS_PANEL_SIZE, 600, true)).toBe(280);
    expect(rightPanelWidthPx(SETTINGS_PANEL_SIZE, 1200, true)).toBe(360);
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
    expect(cam.glideCameraTo).toHaveBeenCalledWith(BX + 360 / 2 / 2, BY, BUILD_VIEW_GLIDE_MS);
  });

  it('in Command: the same one glide', () => {
    useUIStore.setState({ buildMode: false, pilotMode: 'spectator' });
    const cam = camera();
    open();
    frame(cam);
    frame(cam);
    expect(cam.glideCameraTo).toHaveBeenCalledTimes(1);
    expect(cam.glideCameraTo).toHaveBeenCalledWith(190, BY, BUILD_VIEW_GLIDE_MS);
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
