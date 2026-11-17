import { useState } from 'react';
import { Menu, MenuItem, ToggleButton, ToggleButtonGroup } from '@mui/material';
import FlightIcon from '@mui/icons-material/Flight';
import ExploreIcon from '@mui/icons-material/Explore';
import { selectControlMode, useUIStore } from '../state/store';
import { getGameClient } from '../net/clientSingleton';
import { getShipKind } from '@shared-types/shipKinds';
import { sendCommand, sendPilotShip } from '../ships/shipActionsClient';
import type { ControlMode } from '../state/storeTypes';
import { isOwnedByMe, isParkedHull } from '../render/shipOwnership';

/**
 * The ALWAYS-VISIBLE Command ⇄ Fly toggle (two joined MUI `ToggleButton`s).
 * RTS slice 10 renamed it from Pilot / Spectate: normal play starts in
 * **Command** view (free camera over your fleet, every ship AI-flown) and you
 * **Fly** a ship when you want to take the controls.
 *
 * The stored field is still the discrete `pilotMode` enum (Invariant #2 — the
 * free camera pose lives in the renderer, never the store); the toggle reads it
 * through `selectControlMode`. Gated to `phase==='game'`. The test ids keep
 * their old names (`pilot-toggle` = Fly, `spectator-toggle` = Command).
 *
 * **Fly** while in command view: with exactly ONE of your parked ships
 * selected on the map it takes that ship at once; otherwise it opens a menu of
 * your own ships in this sector (the lingering hulls in the render mirror,
 * read once on open — the sanctioned low-cadence `getGameClient().mirror`
 * path), or says there are none. You never flip straight to flying: you fly a
 * SHIP (`sendPilotShip` → the server reclaims it → `welcome` → `pilotMode =
 * 'pilot'`). **Command** lets go: the ship you were flying is handed back to
 * its AI (`sendCommand`).
 */

const GROUP_SX = {
  bgcolor: 'rgba(8,12,22,0.72)',
  borderRadius: 1,
  '& .MuiToggleButton-root': {
    px: { xs: 0.75, sm: 1.25 },
    py: { xs: 0.25, sm: 0.5 },
    fontSize: { xs: 10, sm: 12 },
    lineHeight: 1.1,
    color: '#9aa0b4',
    borderColor: 'rgba(255,255,255,0.12)',
    textTransform: 'none' as const,
    gap: 0.5,
  },
  '& .MuiToggleButton-root.Mui-selected': {
    color: '#00ff88',
    bgcolor: 'rgba(0,255,136,0.12)',
  },
  '& .MuiToggleButton-root.Mui-selected:hover': {
    bgcolor: 'rgba(0,255,136,0.18)',
  },
  '& .MuiSvgIcon-root': { fontSize: { xs: 14, sm: 16 }, mr: 0.4 },
} as const;

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
  const controlMode = useUIStore(selectControlMode);
  const setPilotMode = useUIStore((s) => s.setPilotMode);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [ships, setShips] = useState<PilotableShip[]>([]);

  // A free camera only makes sense in-game (hooks above run unconditionally
  // per React's rules).
  if (phase !== 'game') return null;

  const commanding = controlMode === 'command';

  const onChange = (_e: React.MouseEvent<HTMLElement>, next: ControlMode | null): void => {
    // 'fly' is handled by the Fly button's onClick (takes the selected ship or
    // opens the ship menu) — you never directly flip to flying, you fly a SHIP.
    if (next === 'command') {
      setPilotMode('spectator');
      // Hand the ship we were flying back to its AI. No-op server-side when
      // there's no active hull (death / command-view join).
      sendCommand();
    }
  };

  const onFlyClick = (e: React.MouseEvent<HTMLElement>): void => {
    if (!commanding) return; // already flying → no-op (the button is the active state)
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
    setAnchorEl(e.currentTarget);
  };

  const flyShip = (shipId: string): void => {
    sendPilotShip(shipId);
    setAnchorEl(null);
  };

  return (
    <>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={controlMode}
        onChange={onChange}
        aria-label="Command your fleet or fly a ship"
        data-testid="pilot-spectator-toggle"
        data-control-mode={controlMode}
        sx={GROUP_SX}
      >
        <ToggleButton value="command" data-testid="spectator-toggle" aria-label="Command">
          <ExploreIcon />
          Command
        </ToggleButton>
        <ToggleButton
          value="fly"
          data-testid="pilot-toggle"
          aria-label="Fly a ship"
          onClick={onFlyClick}
        >
          <FlightIcon />
          Fly
        </ToggleButton>
      </ToggleButtonGroup>
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
