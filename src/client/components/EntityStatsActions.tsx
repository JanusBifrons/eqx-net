import { Box, IconButton, Tooltip } from '@mui/material';
import RecyclingIcon from '@mui/icons-material/Recycling';
import BuildIcon from '@mui/icons-material/Build';
import { useUIStore } from '../state/store';
import { sendRefineSalvage, sendRepairShip } from '../structures/structureActionsClient';
import { canManageBuildings } from '../structures/buildingManagement';
import { BountyAction } from './BountyAction';
import { BlueprintInstall } from './BlueprintInstall';
import { ResearchLabPanel } from './ResearchLabPanel';
import { ForeignTeleporterPanel, TeleporterPanel } from './TeleporterPanel';
import { HullUnpack } from './HullUnpack';
import { ACTION_BTN_SX, ICON_SX } from './StructureManageActions';
import { StructureSettings } from './StructureSettings';
import type { PanelData } from './EntityStatsPanel';

/**
 * Inspector sections and owner actions of the Details panel body
 * (`EntityStatsPanel`): repair, refine, your building's settings (Build mode:
 * Power / Build / Manage, StructureSettings.tsx), bounty, blueprints, unpack,
 * lab and teleporters. The one-tap actions (Target, cargo, pod, Pilot, a
 * building's Power) are on the left strip (`layout/`).
 */
export function EntityStatsActions({ data }: { data: PanelData }): JSX.Element {
  const manage = useUIStore(canManageBuildings);
  return (
    <>
      {data.isOwn && data.entityId !== undefined && (data.holdLine !== undefined || data.canRefine === true) && (
        // Phase-1 issue 6 — owner-only action buttons. Repair and refine are
        // pilot services and show in every mode.
        <Box sx={ACTIONS_SX} data-testid="entity-stats-actions">
          {data.holdLine !== undefined && (
            // Living World P1a-2 — instant repair of MY ship here (credit sink).
            <Tooltip title="Repair your ship here (paid from your credits)">
              <IconButton
                data-testid="structure-action-repair-ship"
                size="small"
                sx={ACTION_BTN_SX}
                onClick={() => sendRepairShip()}
              >
                <BuildIcon sx={ICON_SX} />
              </IconButton>
            </Tooltip>
          )}
          {data.canRefine && (
            // Living World P1a-2 — refine the network's salvage into this
            // Capital's mineral bank (funds construction).
            <Tooltip title="Refine salvage into minerals">
              <IconButton
                data-testid="structure-action-refine"
                size="small"
                sx={ACTION_BTN_SX}
                onClick={() => sendRefineSalvage(data.entityId!, 1_000)}
              >
                <RecyclingIcon sx={ICON_SX} />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      )}
      {manage && data.isOwn === true && data.isStructure === true && data.entityId !== undefined && (
        // Building management is Build mode only (`canManageBuildings`).
        <StructureSettings key={data.entityId} entityId={data.entityId} />
      )}
      {data.bountyTarget !== undefined && <BountyAction targetPlayerId={data.bountyTarget} />}
      {data.blueprints !== undefined && data.entityId !== undefined && (
        <BlueprintInstall entityId={data.entityId} blueprints={data.blueprints} />
      )}
      {data.packed !== undefined && data.entityId !== undefined && <HullUnpack entityId={data.entityId} packed={data.packed} />}
      {data.isLab === true && data.entityId !== undefined && <ResearchLabPanel entityId={data.entityId} />}
      {data.isTeleporter === true && data.entityId !== undefined && <TeleporterPanel key={data.entityId} entityId={data.entityId} />}
      {data.isForeignTeleporter === true && data.entityId !== undefined && <ForeignTeleporterPanel key={data.entityId} entityId={data.entityId} />}
    </>
  );
}

// Phase-1 issue 6 — owner-only action-button row.
const ACTIONS_SX = {
  gridColumn: '1 / -1',
  display: 'flex',
  justifyContent: 'center',
  gap: 0.25,
  pt: '2px',
  pointerEvents: 'auto' as const,
};
