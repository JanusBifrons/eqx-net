import { Box, IconButton, Tooltip } from '@mui/material';
import FlightTakeoffIcon from '@mui/icons-material/FlightTakeoff';
import RecyclingIcon from '@mui/icons-material/Recycling';
import BuildIcon from '@mui/icons-material/Build';
import { useUIStore } from '../state/store';
import { sendRefineSalvage, sendRepairShip } from '../structures/structureActionsClient';
import { sendPilotShip } from '../ships/shipActionsClient';
import { canManageBuildings } from '../structures/buildingManagement';
import { BountyAction } from './BountyAction';
import { BlueprintInstall } from './BlueprintInstall';
import { ResearchLabPanel } from './ResearchLabPanel';
import { CargoAction, PodOpen } from './LootWindow';
import { ForeignTeleporterPanel, TeleporterPanel } from './TeleporterPanel';
import { HullUnpack } from './HullUnpack';
import { TargetAction } from './TargetAction';
import { ACTION_BTN_SX, ICON_SX } from './StructureManageActions';
import { StructureSettingsOpen } from './StructureSettingsModal';
import type { PanelData } from './EntityStatsPanel';

/**
 * Inspector sections and action buttons of the click-to-inspect panel
 * (`EntityStatsPanel`): owner actions, bounty, blueprints, unpack, lab,
 * teleporters, cargo, pod, target and pilot.
 */
export function EntityStatsActions({ data }: { data: PanelData }): JSX.Element {
  const manage = useUIStore(canManageBuildings);
  return (
    <>
      {data.isOwn && data.entityId !== undefined && (manage || data.holdLine !== undefined || data.canRefine === true) && (
        // Phase-1 issue 6 — owner-only action buttons. The panel root is
        // pointerEvents:none (passive readout), so this row re-enables pointers.
        // Open (the settings side panel, where building management lives) is
        // Build mode only (`canManageBuildings`); repair and refine are pilot
        // services and show in every mode.
        <Box sx={ACTIONS_SX} data-testid="entity-stats-actions">
          {manage && <StructureSettingsOpen entityId={data.entityId} title={data.name} />}
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
      {data.bountyTarget !== undefined && <BountyAction targetPlayerId={data.bountyTarget} />}
      {data.blueprints !== undefined && data.entityId !== undefined && (
        <BlueprintInstall entityId={data.entityId} blueprints={data.blueprints} />
      )}
      {data.packed !== undefined && data.entityId !== undefined && <HullUnpack entityId={data.entityId} packed={data.packed} />}
      {data.isLab === true && data.entityId !== undefined && <ResearchLabPanel entityId={data.entityId} />}
      {data.isTeleporter === true && data.entityId !== undefined && <TeleporterPanel key={data.entityId} entityId={data.entityId} />}
      {data.isForeignTeleporter === true && data.entityId !== undefined && <ForeignTeleporterPanel key={data.entityId} entityId={data.entityId} />}
      {data.hasCargo === true && data.entityId !== undefined && <CargoAction key={data.entityId} entityId={data.entityId} title={data.name} />}
      {data.cargoShip !== undefined && <CargoAction key={data.cargoShip} ship={data.cargoShip} title={data.name} />}
      {data.podOpen !== undefined && data.entityId !== undefined && <PodOpen key={data.entityId} entityId={data.entityId} inReach={data.podOpen} {...(data.infoLine !== undefined ? { subtitle: data.infoLine } : {})} />}
      <TargetAction isOwn={data.isOwn === true || data.pilotShipId !== undefined} />
      {data.pilotShipId !== undefined && (
        // Phase 4 WS-A2 — in-world Pilot action on the local player's OWN
        // lingering hull. Same-sector instant swap (no spool/curtain); the camera
        // smooth-lerps to the new ship. The panel root is pointerEvents:none, so
        // this row re-enables pointers.
        <Box sx={ACTIONS_SX} data-testid="entity-stats-actions">
          <Tooltip title="Pilot this ship (instant in-sector swap)">
            <IconButton
              data-testid="ship-action-pilot"
              size="small"
              sx={ACTION_BTN_SX}
              onClick={() => sendPilotShip(data.pilotShipId!)}
            >
              <FlightTakeoffIcon sx={ICON_SX} />
            </IconButton>
          </Tooltip>
        </Box>
      )}
    </>
  );
}

// Phase-1 issue 6 — owner-only action-button row. Re-enables pointers (the
// panel root is pointerEvents:none) and keeps the buttons tiny ("start tiny").
const ACTIONS_SX = {
  gridColumn: '1 / -1',
  display: 'flex',
  justifyContent: 'center',
  gap: 0.25,
  pt: '2px',
  pointerEvents: 'auto' as const,
};
