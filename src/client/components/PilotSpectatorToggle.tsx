import { useState } from 'react';
import { Menu, MenuItem, ToggleButton, ToggleButtonGroup } from '@mui/material';
import FlightIcon from '@mui/icons-material/Flight';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { useUIStore } from '../state/store';
import { getGameClient } from '../net/clientSingleton';
import { getShipKind } from '@shared-types/shipKinds';
import { sendPilotShip, sendSpectate } from '../ships/shipActionsClient';
import type { PilotMode } from '../state/storeTypes';

/**
 * Phase 5 — the ALWAYS-VISIBLE Pilot ⇄ Spectate toggle (two joined MUI
 * `ToggleButton`s), the user's explicit ask: "a MUI Toggle Button… two buttons
 * joined together… NOT part of the speeddial". It replaces the speed-dial
 * `spectator-toggle` action (removed) so the mode is a first-class, always-on
 * control rather than buried in a tap-to-expand menu.
 *
 * `pilotMode` is the single discrete store enum (Invariant #2 — the free-roam
 * camera pose lives in the renderer, never the store). Gated to `phase==='game'`.
 *
 * **Pilot dropdown (the user's "if you click the pilot button directly from the
 * UI it should act like a context menu and drop down a list of ships you can
 * pilot, if there are none, it'll tell you that as a placeholder"):** clicking
 * Pilot WHILE SPECTATING opens a menu of the player's OWN in-sector ships (the
 * lingering hulls keyed by shipId in the render mirror, filtered by owner — read
 * once on open, the sanctioned low-cadence `getGameClient().mirror` path).
 * Picking one `sendPilotShip`s it (the server reclaims the hull → `welcome` →
 * `pilotMode='pilot'`; WS-A2). So you never directly flip to 'pilot' — you pilot
 * a SHIP. Spectate is a plain mode flip.
 */

const GROUP_SX = {
  bgcolor: 'rgba(8,12,22,0.6)',
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

/** The player's OWN in-sector ships available to pilot — the lingering (parked)
 *  hulls they own. Read ONCE when the menu opens (no per-frame poll). */
function getPilotableShips(): PilotableShip[] {
  const out: PilotableShip[] = [];
  const mirror = getGameClient()?.mirror;
  const localId = mirror?.localPlayerId;
  if (!mirror || !localId || !mirror.lingeringShips) return out;
  for (const [id, l] of mirror.lingeringShips) {
    if (l.ownerPlayerId === localId) out.push({ shipId: id, label: getShipKind(l.kind).displayName });
  }
  return out;
}

export function PilotSpectatorToggle(): JSX.Element | null {
  const phase = useUIStore((s) => s.phase);
  const pilotMode = useUIStore((s) => s.pilotMode);
  const setPilotMode = useUIStore((s) => s.setPilotMode);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [ships, setShips] = useState<PilotableShip[]>([]);

  // A free-roam construction camera only makes sense in-game (hooks above run
  // unconditionally per React's rules).
  if (phase !== 'game') return null;

  const spectating = pilotMode === 'spectator';

  const onChange = (_e: React.MouseEvent<HTMLElement>, next: PilotMode | null): void => {
    // 'pilot' is handled by the Pilot button's onClick (opens the ship dropdown
    // when spectating) — you never directly flip to 'pilot', you pilot a SHIP.
    if (next === 'spectator') {
      setPilotMode('spectator');
      // Tell the server to DISPLACE our active hull into a lingering hull, so the
      // ship we just left parks in-world AND shows up in the Pilot dropdown (the
      // "no ships to pilot — I just spawned one" fix). No-op server-side when
      // there's no active hull (death / join-as-spectator).
      sendSpectate();
    }
  };

  const onPilotClick = (e: React.MouseEvent<HTMLElement>): void => {
    if (!spectating) return; // already piloting → no-op (the button is the active state)
    setShips(getPilotableShips());
    setAnchorEl(e.currentTarget);
  };

  const pilotShip = (shipId: string): void => {
    sendPilotShip(shipId);
    setAnchorEl(null);
  };

  return (
    <>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={pilotMode}
        onChange={onChange}
        aria-label="Pilot or spectate"
        data-testid="pilot-spectator-toggle"
        sx={GROUP_SX}
      >
        <ToggleButton
          value="pilot"
          data-testid="pilot-toggle"
          aria-label="Pilot ship"
          onClick={onPilotClick}
        >
          <FlightIcon />
          Pilot
        </ToggleButton>
        <ToggleButton value="spectator" data-testid="spectator-toggle" aria-label="Spectate">
          <VisibilityIcon />
          Spectate
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
            No ships to pilot
          </MenuItem>
        ) : (
          ships.map((s) => (
            <MenuItem
              key={s.shipId}
              data-testid={`pilot-menu-ship-${s.shipId}`}
              onClick={() => pilotShip(s.shipId)}
            >
              {s.label}
            </MenuItem>
          ))
        )}
      </Menu>
    </>
  );
}
