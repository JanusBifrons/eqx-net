import { useState } from 'react';
import { Menu, MenuItem } from '@mui/material';
import FlightIcon from '@mui/icons-material/Flight';
import ExploreIcon from '@mui/icons-material/Explore';
import ConstructionIcon from '@mui/icons-material/Construction';
import { selectControlMode, useShouldRenderHud, useUIStore } from '../state/store';
import { getGameClient } from '../net/clientSingleton';
import { getShipKind } from '@shared-types/shipKinds';
import { sendCommand, sendPilotShip } from '../ships/shipActionsClient';
import { isOwnedByMe, isParkedHull } from '../render/shipOwnership';
import { leaveBuildMode } from '../structures/buildModeView';
import { requestBuildSidebar } from './BuildSidebar';
import { EqxSegmented } from '../../ui/index.js';

/**
 * The ALWAYS-VISIBLE mode switch: Fly, Command, Build (one catalogue
 * `EqxSegmented`, `hud` variant; owner 2026-11-20: Build is a third mode, not
 * Command). The group carries the mode as `data-value` (fly/command/build).
 * RTS slice 10 renamed it from Pilot / Spectate: normal play starts in
 * **Command** view (free camera over your fleet, every ship AI-flown) and you
 * **Fly** a ship when you want to take the controls.
 *
 * The stored field is still the discrete `pilotMode` enum (Invariant #2 — the
 * free camera pose lives in the renderer, never the store); the toggle reads it
 * through `selectControlMode`. Gated to `phase==='game'` and the HUD gate (hidden under the loading screen). The test ids keep
 * their old names (`pilot-toggle` = Fly, `spectator-toggle` = Command).
 *
 * **Fly** while in command view: with exactly ONE of your parked ships
 * selected on the map it takes that ship at once; otherwise it opens a menu of
 * your own ships in this sector (the lingering hulls in the render mirror,
 * read once on open — the sanctioned low-cadence `getGameClient().mirror`
 * path), or says there are none. You never flip straight to flying: you fly a
 * SHIP (`sendPilotShip` → the server reclaims it → `welcome` → `pilotMode =
 * 'pilot'`). **Command** lets go: the ship you were flying is handed back to
 * its AI (`sendCommand`). **Build** (`build-toggle`) sets `buildMode`: the
 * hand-over and camera are `buildModeView.ts`, the open build list the speed
 * dial. Fly or Command is the only way out of Build (`leaveBuildMode`); Fly
 * takes back the ship flown before Build, else opens the ship menu.
 */

interface PilotableShip {
  shipId: string;
  label: string;
}

/** The player's OWN in-sector ships available to fly — the lingering (parked)
 *  hulls they own. Read ONCE when the menu opens (no per-frame poll). */
function getPilotableShips(): PilotableShip[] {
  const out: PilotableShip[] = [];
  const mirror = getGameClient()?.mirror;
  if (!mirror || !mirror.localPlayerId) return out;
  // My PARKED hulls only (#17), from the one ship list (RTS Part A S3).
  for (const [id, s] of mirror.ships) {
    if (isParkedHull(mirror, id, s) && isOwnedByMe(mirror, id, s)) out.push({ shipId: id, label: getShipKind(s.kind).displayName });
  }
  return out;
}

export function PilotSpectatorToggle(): JSX.Element | null {
  const phase = useUIStore((s) => s.phase);
  const hudUp = useShouldRenderHud();
  const controlMode = useUIStore(selectControlMode);
  const setPilotMode = useUIStore((s) => s.setPilotMode);
  const setBuildMode = useUIStore((s) => s.setBuildMode);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [ships, setShips] = useState<PilotableShip[]>([]);

  // A free camera only makes sense in-game (hooks above run unconditionally
  // per React's rules).
  // Hidden while the sector loads: only once you are in and controllable.
  if (phase !== 'game' || !hudUp) return null;

  const onChange = (next: string): void => {
    // 'fly' is handled by the Fly button's onClick (takes the selected ship or
    // opens the ship menu) — you never directly flip to flying, you fly a SHIP.
    if (next === 'build') {
      setBuildMode(true);
      return;
    }
    if (next === 'command') {
      // From Build the ship is already AI-flown: just leave Build.
      if (controlMode === 'build') {
        leaveBuildMode('command');
        return;
      }
      setPilotMode('spectator');
      // Hand the ship we were flying back to its AI. No-op server-side when
      // there's no active hull (death / command-view join).
      sendCommand();
    }
  };

  // Already in Build: the exclusive group sends no change, so a tap here brings
  // the Build sidebar back after a ✕ (the only way in since the dial stopped
  // building, owner 2026-11-22).
  const onBuildClick = (): void => {
    if (controlMode === 'build') requestBuildSidebar();
  };

  const onFlyClick = (button: HTMLElement): void => {
    if (controlMode === 'fly') return; // already flying → no-op (the button is the active state)
    // Leaving Build: fly the ship flown before Build, else pick one from Command.
    if (controlMode === 'build' && leaveBuildMode('fly')) return;
    const own = getPilotableShips();
    const selected = useUIStore.getState().selection.ids;
    if (selected.length === 1) {
      const pick = own.find((s) => s.shipId === selected[0]);
      if (pick) {
        sendPilotShip(pick.shipId);
        return;
      }
    }
    setShips(own);
    setAnchorEl(button);
  };

  const flyShip = (shipId: string): void => {
    sendPilotShip(shipId);
    setAnchorEl(null);
  };

  return (
    <>
      <EqxSegmented
        hud
        value={controlMode}
        onChange={onChange}
        label="Fly a ship, command your fleet or build"
        data-testid="pilot-spectator-toggle"
        options={[
          { id: 'fly', label: 'Fly', icon: <FlightIcon />, testId: 'pilot-toggle', onPress: onFlyClick },
          { id: 'command', label: 'Command', icon: <ExploreIcon />, testId: 'spectator-toggle' },
          { id: 'build', label: 'Build', icon: <ConstructionIcon />, testId: 'build-toggle', onPress: onBuildClick },
        ]}
      />
      <Menu
        anchorEl={anchorEl}
        open={anchorEl !== null}
        onClose={() => setAnchorEl(null)}
        data-testid="pilot-menu"
      >
        {ships.length === 0 ? (
          <MenuItem disabled data-testid="pilot-menu-empty">
            No ships to fly
          </MenuItem>
        ) : (
          ships.map((s) => (
            <MenuItem
              key={s.shipId}
              data-testid={`pilot-menu-ship-${s.shipId}`}
              onClick={() => flyShip(s.shipId)}
            >
              {s.label}
            </MenuItem>
          ))
        )}
      </Menu>
    </>
  );
}
