/**
 * The Access tab of the building settings window, for a Shield Gate or
 * Airlock: who it opens for, and the owner's button that cycles it (owner +
 * allies → owner only → anyone not hostile → …), sent on `set_gate_access`.
 * The value is read from the structure slice (`gateAccess`) at the window's
 * 4 Hz cadence, so the tab follows the server.
 */
import { useEffect, useState } from 'react';
import { Box, Tooltip } from '@mui/material';
import { getGameClient } from '../net/clientSingleton';
import { sendSetGateAccess } from '../structures/structureActionsClient';
import { gateTypeOf } from '@core/structures/gateGeometry';
import { GATE_ACCESS_IDS, GATE_ACCESS_LABELS, gateAccessFromIndex, type GateAccess } from '@shared-types/gateAccess';

/** A kind with an Access tab: the gates. */
export function hasGateAccess(kindId: string): boolean {
  return gateTypeOf(kindId) !== null;
}

/** The next gate access setting in the cycle (owner + allies → owner only →
 *  anyone not hostile → …). */
export function nextGateAccess(a: GateAccess): GateAccess {
  const i = GATE_ACCESS_IDS.indexOf(a);
  return GATE_ACCESS_IDS[(i + 1) % GATE_ACCESS_IDS.length]!;
}

function readGateAccess(entityId: number): GateAccess | null {
  const st = getGameClient()?.mirror.structures?.get(entityId);
  return st ? gateAccessFromIndex(st.gateAccess) : null;
}

export interface GateTabProps {
  entityId: number;
  pollMs: number;
  /** The window's shared grid / label / value / button styles. */
  gridSx: object;
  labelSx: object;
  valueSx: object;
  btnSx: object;
}

export function GateTab({ entityId, pollMs, gridSx, labelSx, valueSx, btnSx }: GateTabProps): JSX.Element {
  const [access, setAccess] = useState<GateAccess | null>(() => readGateAccess(entityId));
  useEffect(() => {
    const h = window.setInterval(() => setAccess(readGateAccess(entityId)), pollMs);
    return () => window.clearInterval(h);
  }, [entityId, pollMs]);
  if (access === null) return <Box sx={labelSx}>No gate data</Box>;
  return (
    <Box data-testid="structure-settings-access" data-gate-access={access} sx={gridSx}>
      <Box sx={labelSx}>Opens for</Box>
      <Box sx={ROW_SX}>
        <Box sx={valueSx} data-testid="settings-gate-access">{GATE_ACCESS_LABELS[access]}</Box>
        <Tooltip title="Change who this gate opens for">
          <Box component="button" sx={btnSx} data-testid="structure-action-gate-access"
            onClick={() => sendSetGateAccess(entityId, nextGateAccess(access))}>Change</Box>
        </Tooltip>
      </Box>
    </Box>
  );
}

const ROW_SX = { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 1 } as const;
